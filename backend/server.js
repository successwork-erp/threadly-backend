const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { connectDB } = require('./mongo');
const Supplier = require('./models/Supplier');
const Buyer = require('./models/Buyer');
const Product = require('./models/Product');
const Order = require('./models/Order');
const InstantCashRequest = require('./models/InstantCashRequest');
const Review = require('./models/Review');
const Party = require('./models/Party');
const PurchaseBill = require('./models/PurchaseBill');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'demo-secret-change-in-production';

// Razorpay client — only initializes if keys are set. Payment routes check this
// and return a clear error rather than crashing the whole server if keys are missing.
const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

app.use(cors());
app.use(express.json());

// ---- File uploads (product images + review media) ----
// Stored on Cloudinary (free tier) instead of local disk — Render's local disk is
// wiped on every restart/redeploy, which was silently deleting product photos and
// review media while the URLs still pointed at the now-missing files. Cloudinary
// URLs are permanent regardless of backend redeploys.
const cloudinaryConfigured = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
} else {
  console.error('Cloudinary env vars are not set (CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET). Image uploads will fail until these are added in Render → Environment.');
}

// Old local-disk uploads (from before this change) are still served here, in case
// any already-saved records still point at a relative /uploads/... path.
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

const cloudinaryStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'threadly',
    resource_type: 'auto', // auto-detects image vs video, needed for review media
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov', 'webm'],
  },
});
const upload = multer({ storage: cloudinaryStorage });
// Review media can include short video clips, so cap size a bit higher than a typical photo.
const uploadReviewMedia = multer({ storage: cloudinaryStorage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB per file

// ---- Auth middleware ----
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });
  const token = header.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.supplierId = decoded.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function safeSupplier(supplierDoc) {
  const s = supplierDoc.toObject ? supplierDoc.toObject() : supplierDoc;
  const { password, securityAnswer, __v, ...rest } = s;
  return { ...rest, id: s._id.toString() };
}

// ---- Buyer auth middleware (separate from supplier auth above) ----
function buyerAuthMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });
  const token = header.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'buyer') return res.status(401).json({ error: 'Invalid token type' });
    req.buyerId = decoded.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function safeBuyer(buyerDoc) {
  const b = buyerDoc.toObject ? buyerDoc.toObject() : buyerDoc;
  const { password, __v, ...rest } = b;
  return { ...rest, id: b._id.toString() };
}

function safeProduct(productDoc, supplierName) {
  const p = productDoc.toObject ? productDoc.toObject() : productDoc;
  const { __v, _id, ...rest } = p;
  return { ...rest, id: _id.toString(), supplierId: p.supplierId.toString(), supplierName: supplierName || undefined };
}

// ================= SUPPLIER AUTH =================

// Register supplier
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, mobile, password, securityQuestion, securityAnswer } = req.body;
    if (!name || !email || !mobile || !password) {
      return res.status(400).json({ error: 'Name, email, mobile and password are required' });
    }

    const exists = await Supplier.findOne({ $or: [{ email }, { mobile }] });
    if (exists) return res.status(409).json({ error: 'Supplier with this email or mobile already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const supplier = await Supplier.create({
      name, email, mobile,
      password: hashedPassword,
      securityQuestion: securityQuestion || null,
      securityAnswer: securityAnswer || null,
    });

    const token = jwt.sign({ id: supplier._id.toString() }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, supplier: safeSupplier(supplier) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login supplier
app.post('/api/auth/login', async (req, res) => {
  try {
    const { emailOrMobile, password } = req.body;
    if (!emailOrMobile || !password) {
      return res.status(400).json({ error: 'Email/mobile and password are required' });
    }

    const supplier = await Supplier.findOne({ $or: [{ email: emailOrMobile }, { mobile: emailOrMobile }] });
    if (!supplier) return res.status(404).json({ error: 'No account found with this email/mobile' });

    const match = await bcrypt.compare(password, supplier.password);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });

    const token = jwt.sign({ id: supplier._id.toString() }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, supplier: safeSupplier(supplier) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current supplier profile
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.supplierId);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    res.json(safeSupplier(supplier));
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ================= BUYER AUTH =================

// Buyer: register a new account
app.post('/api/buyer/register', async (req, res) => {
  try {
    const { name, email, mobile, password } = req.body;
    if (!name || !email || !mobile || !password) {
      return res.status(400).json({ error: 'Name, email, mobile and password are required' });
    }

    const exists = await Buyer.findOne({ $or: [{ email }, { mobile }] });
    if (exists) return res.status(409).json({ error: 'An account with this email or mobile already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const buyer = await Buyer.create({ name, email, mobile, password: hashedPassword, approvalStatus: 'pending' });

    // No token here — buyers cannot log in until a supplier approves them on the web portal.
    res.json({
      success: true,
      message: 'Registration submitted. Your account will be reviewed and you can log in once approved.',
      approvalStatus: buyer.approvalStatus,
    });
  } catch (err) {
    console.error('Buyer register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Buyer: log in
app.post('/api/buyer/login', async (req, res) => {
  try {
    const { emailOrMobile, password } = req.body;
    if (!emailOrMobile || !password) {
      return res.status(400).json({ error: 'Email/mobile and password are required' });
    }

    const buyer = await Buyer.findOne({ $or: [{ email: emailOrMobile }, { mobile: emailOrMobile }] });
    if (!buyer) return res.status(404).json({ error: 'No account found with this email/mobile' });

    const match = await bcrypt.compare(password, buyer.password);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });

    if (buyer.approvalStatus === 'pending') {
      return res.status(403).json({ error: 'Your account is awaiting approval from the seller. Please check back later.', approvalStatus: 'pending' });
    }
    if (buyer.approvalStatus === 'rejected') {
      return res.status(403).json({ error: 'Your account registration was not approved.', approvalStatus: 'rejected' });
    }

    const token = jwt.sign({ id: buyer._id.toString(), type: 'buyer' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, buyer: safeBuyer(buyer) });
  } catch (err) {
    console.error('Buyer login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Buyer: get own profile (confirms/restores session on app open)
app.get('/api/buyer/me', buyerAuthMiddleware, async (req, res) => {
  try {
    const buyer = await Buyer.findById(req.buyerId);
    if (!buyer) return res.status(404).json({ error: 'Buyer not found' });
    res.json(safeBuyer(buyer));
  } catch (err) {
    console.error('Buyer me error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// Buyer: view own order history (this is the actual feature buyer accounts unlock —
// a real "My Orders" list, instead of needing to save each Order ID separately)
app.get('/api/buyer/orders', buyerAuthMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ buyerId: req.buyerId }).sort({ createdAt: -1 });
    res.json(orders.map(o => {
      const obj = o.toObject();
      const { __v, _id, supplierId, buyerId, ...rest } = obj;
      return { ...rest, id: _id.toString() };
    }));
  } catch (err) {
    console.error('Buyer orders error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Buyer: manage saved delivery addresses
app.get('/api/buyer/addresses', buyerAuthMiddleware, async (req, res) => {
  try {
    const buyer = await Buyer.findById(req.buyerId);
    if (!buyer) return res.status(404).json({ error: 'Buyer not found' });
    res.json(buyer.addresses);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load addresses' });
  }
});

app.post('/api/buyer/addresses', buyerAuthMiddleware, async (req, res) => {
  try {
    const { label, address, pincode } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required' });

    const buyer = await Buyer.findById(req.buyerId);
    if (!buyer) return res.status(404).json({ error: 'Buyer not found' });

    buyer.addresses.push({ label: label || 'Home', address, pincode: pincode || '' });
    await buyer.save();
    res.json(buyer.addresses);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add address' });
  }
});

// ================= PRODUCTS =================

// Public: list all products (this is what the mobile app polls)
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    const supplierIds = [...new Set(products.map(p => p.supplierId.toString()))];
    const suppliers = await Supplier.find({ _id: { $in: supplierIds } });
    const nameById = Object.fromEntries(suppliers.map(s => [s._id.toString(), s.businessName || s.name]));

    res.json(products.map(p => safeProduct(p, nameById[p.supplierId.toString()] || 'Unknown')));
  } catch (err) {
    console.error('List products error:', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// Supplier: list own products
app.get('/api/products/mine', authMiddleware, async (req, res) => {
  try {
    const mine = await Product.find({ supplierId: req.supplierId }).sort({ createdAt: -1 });
    res.json(mine.map(p => safeProduct(p)));
  } catch (err) {
    console.error('My products error:', err);
    res.status(500).json({ error: 'Failed to load your products' });
  }
});

// Supplier: add a product (T-shirt) - supports multiple images plus per-size stock
app.post('/api/products', authMiddleware, upload.array('images', 6), async (req, res) => {
  try {
    const b = req.body;
    if (!b.title || !b.price) return res.status(400).json({ error: 'Title and price are required' });

    let parsedSizeStock = [];
    try {
      parsedSizeStock = b.sizeStock ? JSON.parse(b.sizeStock) : [];
    } catch (e) {
      parsedSizeStock = [];
    }

    const splitList = (v) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : []);

    const imageUrls = (req.files && req.files.length > 0) ? req.files.map(f => f.path) : [];

    const product = await Product.create({
      supplierId: req.supplierId,
      category: 'T-Shirt',
      gst: b.gst || '',
      hsnCode: b.hsnCode || '',
      netWeight: b.netWeight || '',
      styleCode: b.styleCode || '',
      title: b.title,
      price: Number(b.price),
      mrp: b.mrp ? Number(b.mrp) : Number(b.price),
      color: splitList(b.color),
      fabric: b.fabric || '',
      fitShape: b.fitShape || '',
      genericName: b.genericName || '',
      netQuantity: b.netQuantity || '1',
      neck: b.neck || '',
      occasion: b.occasion || '',
      pattern: b.pattern || '',
      printOrPatternType: b.printOrPatternType || '',
      sleeveLength: b.sleeveLength || '',
      countryOfOrigin: b.countryOfOrigin || 'India',
      manufacturerName: b.manufacturerName || '',
      manufacturerAddress: b.manufacturerAddress || '',
      manufacturerPincode: b.manufacturerPincode || '',
      packerName: b.packerName || '',
      packerAddress: b.packerAddress || '',
      packerPincode: b.packerPincode || '',
      importerName: b.importerName || '',
      importerAddress: b.importerAddress || '',
      importerPincode: b.importerPincode || '',
      brand: b.brand || '',
      character: b.character || '',
      hemline: b.hemline || '',
      length: b.length || '',
      numberOfPockets: b.numberOfPockets || '',
      sleeveStyling: b.sleeveStyling || '',
      style: b.style || '',
      description: b.description || '',
      sizeStock: parsedSizeStock.length > 0 ? parsedSizeStock : [{ size: 'M', stock: 0 }],
      stock: parsedSizeStock.length > 0 ? parsedSizeStock.reduce((sum, s) => sum + Number(s.stock || 0), 0) : 0,
      imageUrls,
      imageUrl: imageUrls.length > 0 ? imageUrls[0] : null,
      status: 'live',
    });

    res.json(safeProduct(product));
  } catch (err) {
    console.error('Add product error:', err);
    res.status(500).json({ error: 'Failed to add product' });
  }
});

// Supplier: update a product
app.put('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const b = req.body;
    const directFields = [
      'gst', 'hsnCode', 'netWeight', 'styleCode', 'title', 'fabric', 'fitShape',
      'genericName', 'netQuantity', 'neck', 'occasion', 'pattern', 'printOrPatternType',
      'sleeveLength', 'countryOfOrigin', 'manufacturerName', 'manufacturerAddress',
      'manufacturerPincode', 'packerName', 'packerAddress', 'packerPincode',
      'importerName', 'importerAddress', 'importerPincode', 'brand', 'character',
      'hemline', 'length', 'numberOfPockets', 'sleeveStyling', 'style', 'description', 'status',
    ];
    directFields.forEach((field) => {
      if (b[field] !== undefined) product[field] = b[field];
    });

    if (b.price !== undefined) product.price = Number(b.price);
    if (b.mrp !== undefined) product.mrp = Number(b.mrp);
    if (b.color !== undefined) {
      product.color = Array.isArray(b.color) ? b.color : b.color.split(',').map(c => c.trim());
    }
    if (b.sizeStock !== undefined) {
      product.sizeStock = Array.isArray(b.sizeStock) ? b.sizeStock : JSON.parse(b.sizeStock);
      product.stock = product.sizeStock.reduce((sum, s) => sum + Number(s.stock || 0), 0);
    }

    await product.save();
    res.json(safeProduct(product));
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Supplier: add images to an existing product (Image Bulk Upload page)
app.post('/api/products/:id/images', authMiddleware, upload.array('images', 6), async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No images provided' });

    const newUrls = req.files.map(f => f.path);
    product.imageUrls = [...(product.imageUrls || []), ...newUrls].slice(0, 6);
    if (!product.imageUrl && product.imageUrls.length > 0) product.imageUrl = product.imageUrls[0];

    await product.save();
    res.json(safeProduct(product));
  } catch (err) {
    console.error('Bulk image upload error:', err);
    res.status(500).json({ error: 'Failed to upload images' });
  }
});

// Supplier: delete a product
app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const result = await Product.deleteOne({ _id: req.params.id, supplierId: req.supplierId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ================= INVENTORY & PRICING (reuse product data) =================

// Supplier: inventory view (stock levels per product/size)
app.get('/api/inventory', authMiddleware, async (req, res) => {
  try {
    const mine = await Product.find({ supplierId: req.supplierId }).sort({ createdAt: -1 });
    res.json(mine.map(p => safeProduct(p)));
  } catch (err) {
    console.error('Inventory error:', err);
    res.status(500).json({ error: 'Failed to load inventory' });
  }
});

// Supplier: update stock for a product (from Inventory page)
app.put('/api/inventory/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    if (req.body.sizeStock !== undefined) {
      product.sizeStock = req.body.sizeStock;
      product.stock = product.sizeStock.reduce((sum, s) => sum + Number(s.stock || 0), 0);
    }
    await product.save();
    res.json(safeProduct(product));
  } catch (err) {
    console.error('Inventory update error:', err);
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

// Supplier: pricing view (price/MRP per product)
app.get('/api/pricing', authMiddleware, async (req, res) => {
  try {
    const mine = await Product.find({ supplierId: req.supplierId }).sort({ createdAt: -1 });
    res.json(mine.map(p => safeProduct(p)));
  } catch (err) {
    console.error('Pricing error:', err);
    res.status(500).json({ error: 'Failed to load pricing' });
  }
});

// Supplier: update price/MRP for a product (from Pricing page)
app.put('/api/pricing/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    if (req.body.price !== undefined) product.price = Number(req.body.price);
    if (req.body.mrp !== undefined) product.mrp = Number(req.body.mrp);
    await product.save();
    res.json(safeProduct(product));
  } catch (err) {
    console.error('Pricing update error:', err);
    res.status(500).json({ error: 'Failed to update pricing' });
  }
});

// ================= BUYER CHECKOUT (public, no login required) =================

// Buyer: place an order for a product. Called by the Flutter app's "Buy Now" button.
// No authentication needed — buyers don't have accounts (by design). Buyer contact
// details are captured directly on the order.
app.post('/api/checkout', async (req, res) => {
  try {
    const { productId, size, quantity, buyerName, buyerMobile, shippingAddress, shippingPincode } = req.body;

    if (!productId || !size || !buyerName || !buyerMobile || !shippingAddress) {
      return res.status(400).json({
        error: 'productId, size, buyerName, buyerMobile, and shippingAddress are required',
      });
    }

    // If the buyer is logged in, link this order to their account so it shows up
    // in their order history. Checkout works fine without this too (guest checkout).
    let buyerId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET);
        if (decoded.type === 'buyer') buyerId = decoded.id;
      } catch (e) {
        // Invalid/expired token on checkout — proceed as guest rather than failing the order
      }
    }

    const qty = Number(quantity) > 0 ? Number(quantity) : 1;

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.status !== 'live') return res.status(400).json({ error: 'This product is not currently available' });

    const sizeEntry = product.sizeStock.find(s => s.size === size);
    if (!sizeEntry) return res.status(400).json({ error: `Size ${size} is not available for this product` });
    if (sizeEntry.stock < qty) {
      return res.status(400).json({ error: `Only ${sizeEntry.stock} left in size ${size}` });
    }

    // Deduct stock atomically-ish: re-check and save. Fine for this scale; for high
    // concurrency this should use a Mongo transaction or findOneAndUpdate with a
    // stock >= qty filter.
    sizeEntry.stock -= qty;
    product.stock = product.sizeStock.reduce((sum, s) => sum + Number(s.stock || 0), 0);
    await product.save();

    const order = await Order.create({
      supplierId: product.supplierId,
      buyerId,
      items: [{
        productId: product._id,
        title: product.title,
        imageUrl: product.imageUrl,
        size,
        quantity: qty,
        price: product.price,
      }],
      totalAmount: product.price * qty,
      buyerName,
      buyerMobile,
      shippingAddress,
      shippingPincode: shippingPincode || '',
      status: 'pending',
      paymentStatus: 'pending',
    });

    res.json({
      success: true,
      orderId: order._id.toString(),
      message: 'Order placed successfully',
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

// ================= RAZORPAY PAYMENTS (test mode) =================

// Buyer: create a Razorpay payment order for an existing Threadly order.
// Called after checkout, when the buyer chooses "Pay Online" instead of COD.
app.post('/api/payments/create-order', async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: 'Online payments are not configured yet. Please choose Cash on Delivery.' });
    }

    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paymentStatus === 'paid') return res.status(400).json({ error: 'This order is already paid' });

    // Razorpay amount is in paise (smallest currency unit), and needs a short receipt id
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(order.totalAmount * 100),
      currency: 'INR',
      receipt: order._id.toString(),
      notes: { threadlyOrderId: order._id.toString() },
    });

    res.json({
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Razorpay create-order error:', err);
    res.status(500).json({ error: 'Failed to start payment. Please try again.' });
  }
});

// Buyer: verify payment after Razorpay's checkout completes.
// This is the security-critical step — never trust a "payment succeeded" claim
// from the app itself; always verify Razorpay's signature server-side first.
app.post('/api/payments/verify', async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: 'Online payments are not configured yet.' });
    }

    const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!orderId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification details' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed. This payment could not be confirmed as genuine.' });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.paymentStatus = 'paid';
    order.paidAt = new Date();
    await order.save();

    res.json({ success: true, message: 'Payment verified and order marked as paid' });
  } catch (err) {
    console.error('Razorpay verify error:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Buyer: track an order by its ID (no login — the order ID itself is the receipt/tracking code)
app.get('/api/track/:orderId', async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found. Check your order ID and try again.' });

    res.json({
      orderId: order._id.toString(),
      status: order.status,
      items: order.items,
      totalAmount: order.totalAmount,
      buyerName: order.buyerName,
      shippingAddress: order.shippingAddress,
      shippingPincode: order.shippingPincode,
      paymentStatus: order.paymentStatus,
      orderDate: order.orderDate,
      returnStatus: order.returnStatus,
    });
  } catch (err) {
    // Invalid ObjectId format also lands here
    res.status(404).json({ error: 'Order not found. Check your order ID and try again.' });
  }
});

// Buyer: get a printable invoice for an order by its ID (no login needed, same as tracking)
app.get('/api/invoice/:orderId', async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const supplier = await Supplier.findById(order.supplierId);

    res.json({
      orderId: order._id.toString(),
      orderDate: order.orderDate,
      items: order.items,
      totalAmount: order.totalAmount,
      buyerName: order.buyerName,
      buyerMobile: order.buyerMobile,
      shippingAddress: order.shippingAddress,
      shippingPincode: order.shippingPincode,
      paymentStatus: order.paymentStatus,
      sellerName: supplier?.businessName || supplier?.name || 'Threadly Seller',
      sellerGst: order.items?.[0]?.gst || '',
    });
  } catch (err) {
    res.status(404).json({ error: 'Order not found' });
  }
});

// ================= ORDERS =================

function safeOrder(orderDoc) {
  const o = orderDoc.toObject ? orderDoc.toObject() : orderDoc;
  const { __v, _id, supplierId, ...rest } = o;
  return { ...rest, id: _id.toString(), supplierId: supplierId.toString() };
}

// Supplier: list own orders (optional ?status= filter)
app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const filter = { supplierId: req.supplierId };
    if (req.query.status) filter.status = req.query.status;
    const orders = await Order.find(filter).sort({ createdAt: -1 });
    res.json(orders.map(safeOrder));
  } catch (err) {
    console.error('List orders error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Supplier: get one order
app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(safeOrder(order));
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// Supplier: update order status (pending -> packed -> shipped -> delivered, or cancelled)
app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const allowed = ['pending', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'];
    if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });

    order.status = req.body.status;
    await order.save();
    res.json(safeOrder(order));
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Supplier: mark a shipping label as downloaded (Barcoded Packaging page)
app.post('/api/orders/:id/label', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    order.labelDownloaded = true;
    await order.save();
    res.json(safeOrder(order));
  } catch (err) {
    console.error('Label error:', err);
    res.status(500).json({ error: 'Failed to update label status' });
  }
});

// ================= RETURNS =================

// Buyer: request a return on a delivered order (no login — same order-ID pattern as tracking/invoice)
app.post('/api/returns/request', async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason for the return is required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found. Check your order ID and try again.' });

    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Returns can only be requested for orders that have been delivered.' });
    }
    if (order.returnStatus !== 'none') {
      return res.status(400).json({ error: `A return has already been ${order.returnStatus} for this order.` });
    }

    order.returnRequested = true;
    order.returnReason = reason.trim();
    order.returnStatus = 'requested';
    await order.save();

    res.json({ success: true, message: 'Return request submitted. The seller will review it shortly.', returnStatus: order.returnStatus });
  } catch (err) {
    console.error('Return request error:', err);
    res.status(404).json({ error: 'Order not found. Check your order ID and try again.' });
  }
});

// Supplier: list orders with a return requested
app.get('/api/returns', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ supplierId: req.supplierId, returnRequested: true }).sort({ createdAt: -1 });
    res.json(orders.map(safeOrder));
  } catch (err) {
    console.error('List returns error:', err);
    res.status(500).json({ error: 'Failed to load returns' });
  }
});

// Supplier: approve/reject/complete a return
app.put('/api/returns/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const allowed = ['requested', 'approved', 'rejected', 'completed'];
    if (!allowed.includes(req.body.returnStatus)) return res.status(400).json({ error: 'Invalid return status' });

    order.returnStatus = req.body.returnStatus;
    if (req.body.returnStatus === 'completed') order.status = 'returned';
    await order.save();
    res.json(safeOrder(order));
  } catch (err) {
    console.error('Update return error:', err);
    res.status(500).json({ error: 'Failed to update return' });
  }
});

// ================= CLAIMS =================

// Supplier: list orders with a claim raised
app.get('/api/claims', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ supplierId: req.supplierId, claimRaised: true }).sort({ createdAt: -1 });
    res.json(orders.map(safeOrder));
  } catch (err) {
    console.error('List claims error:', err);
    res.status(500).json({ error: 'Failed to load claims' });
  }
});

// Supplier: resolve/reject a claim
app.put('/api/claims/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const allowed = ['open', 'resolved', 'rejected'];
    if (!allowed.includes(req.body.claimStatus)) return res.status(400).json({ error: 'Invalid claim status' });

    order.claimStatus = req.body.claimStatus;
    await order.save();
    res.json(safeOrder(order));
  } catch (err) {
    console.error('Update claim error:', err);
    res.status(500).json({ error: 'Failed to update claim' });
  }
});

// ================= REVIEWS =================

// Buyer: submit a review with star rating + optional photos/videos (no login needed —
// eligibility is proven by owning a delivered order, same order-ID pattern as returns/tracking)
app.post('/api/reviews', uploadReviewMedia.array('media', 4), async (req, res) => {
  try {
    const { orderId, rating, comment } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const ratingNum = Number(rating);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'rating must be a number from 1 to 5' });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found. Check your order ID and try again.' });

    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'You can only review a product after your order has been delivered.' });
    }

    const existing = await Review.findOne({ orderId: order._id });
    if (existing) return res.status(409).json({ error: 'You have already reviewed this order.' });

    const mediaUrls = (req.files && req.files.length > 0) ? req.files.map((f) => f.path) : [];

    const review = await Review.create({
      productId: order.items[0].productId,
      orderId: order._id,
      buyerName: order.buyerName,
      buyerId: order.buyerId || null,
      rating: ratingNum,
      comment: comment ? comment.trim() : '',
      mediaUrls,
    });

    res.json({ success: true, review: { ...review.toObject(), id: review._id.toString() } });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'You have already reviewed this order.' });
    console.error('Submit review error:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// Public: list reviews for a product (shown on the product page in the app/web)
app.get('/api/products/:id/reviews', async (req, res) => {
  try {
    const reviews = await Review.find({ productId: req.params.id }).sort({ createdAt: -1 });
    const summary = reviews.length
      ? { count: reviews.length, average: Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10 }
      : { count: 0, average: 0 };
    res.json({
      summary,
      reviews: reviews.map((r) => ({
        id: r._id.toString(),
        buyerName: r.buyerName,
        rating: r.rating,
        comment: r.comment,
        mediaUrls: r.mediaUrls,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('List reviews error:', err);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// ================= BUYER APPROVALS =================

// Supplier: list buyers awaiting approval (any logged-in supplier can see/act on these)
app.get('/api/buyer-approvals', authMiddleware, async (req, res) => {
  try {
    const status = req.query.status || 'pending'; // pending | approved | rejected | all
    const filter = status === 'all' ? {} : { approvalStatus: status };
    const buyers = await Buyer.find(filter).sort({ createdAt: -1 });
    res.json(buyers.map(safeBuyer));
  } catch (err) {
    console.error('List buyer approvals error:', err);
    res.status(500).json({ error: 'Failed to load buyer approvals' });
  }
});

// Supplier: approve or reject a buyer's registration
app.put('/api/buyer-approvals/:id', authMiddleware, async (req, res) => {
  try {
    const { action } = req.body; // 'approve' or 'reject'
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    }

    const buyer = await Buyer.findById(req.params.id);
    if (!buyer) return res.status(404).json({ error: 'Buyer not found' });

    buyer.approvalStatus = action === 'approve' ? 'approved' : 'rejected';
    await buyer.save();

    res.json({ success: true, buyer: safeBuyer(buyer) });
  } catch (err) {
    console.error('Buyer approval action error:', err);
    res.status(500).json({ error: 'Failed to update buyer approval status' });
  }
});

// ================= PARTIES (Vendors) =================
// A "Party" is a vendor the supplier buys raw materials/stock from — separate from Buyers.

app.get('/api/parties', authMiddleware, async (req, res) => {
  try {
    const parties = await Party.find({ supplierId: req.supplierId }).sort({ createdAt: -1 });
    res.json(parties);
  } catch (err) {
    console.error('List parties error:', err);
    res.status(500).json({ error: 'Failed to load parties' });
  }
});

app.post('/api/parties', authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, gstin, address, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Party name is required' });

    const party = await Party.create({
      supplierId: req.supplierId,
      name: name.trim(),
      phone: phone || '',
      email: email || '',
      gstin: gstin || '',
      address: address || '',
      notes: notes || '',
    });
    res.json(party);
  } catch (err) {
    console.error('Create party error:', err);
    res.status(500).json({ error: 'Failed to create party' });
  }
});

app.put('/api/parties/:id', authMiddleware, async (req, res) => {
  try {
    const party = await Party.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!party) return res.status(404).json({ error: 'Party not found' });

    const { name, phone, email, gstin, address, notes } = req.body;
    if (name !== undefined) party.name = name;
    if (phone !== undefined) party.phone = phone;
    if (email !== undefined) party.email = email;
    if (gstin !== undefined) party.gstin = gstin;
    if (address !== undefined) party.address = address;
    if (notes !== undefined) party.notes = notes;
    await party.save();

    res.json(party);
  } catch (err) {
    console.error('Update party error:', err);
    res.status(500).json({ error: 'Failed to update party' });
  }
});

app.delete('/api/parties/:id', authMiddleware, async (req, res) => {
  try {
    const party = await Party.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!party) return res.status(404).json({ error: 'Party not found' });

    const billCount = await PurchaseBill.countDocuments({ partyId: party._id });
    if (billCount > 0) {
      return res.status(400).json({ error: `Cannot delete — this party has ${billCount} purchase bill(s) on record.` });
    }

    await party.deleteOne();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete party error:', err);
    res.status(500).json({ error: 'Failed to delete party' });
  }
});

// ================= PURCHASE BILLS =================

app.get('/api/purchase-bills', authMiddleware, async (req, res) => {
  try {
    const bills = await PurchaseBill.find({ supplierId: req.supplierId }).populate('partyId', 'name phone').sort({ createdAt: -1 });
    res.json(bills);
  } catch (err) {
    console.error('List purchase bills error:', err);
    res.status(500).json({ error: 'Failed to load purchase bills' });
  }
});

app.post('/api/purchase-bills', authMiddleware, async (req, res) => {
  try {
    const { partyId, billNumber, billDate, items, paidAmount, paymentType, notes } = req.body;

    if (!partyId) return res.status(400).json({ error: 'A party (vendor) is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

    const party = await Party.findOne({ _id: partyId, supplierId: req.supplierId });
    if (!party) return res.status(404).json({ error: 'Party not found' });

    // Validate and compute each line item's amount server-side — never trust client-computed totals.
    const cleanItems = [];
    let totalAmount = 0;
    for (const it of items) {
      const quantity = Number(it.quantity);
      const price = Number(it.price);
      if (!it.itemName || !quantity || quantity <= 0 || !price || price < 0) {
        return res.status(400).json({ error: 'Each item needs a name, a positive quantity, and a valid price' });
      }
      const amount = Math.round(quantity * price * 100) / 100;
      totalAmount += amount;
      cleanItems.push({ productId: it.productId || null, itemName: it.itemName, quantity, price, amount });
    }
    totalAmount = Math.round(totalAmount * 100) / 100;

    const paid = Math.max(0, Number(paidAmount) || 0);
    const balanceDue = Math.round((totalAmount - paid) * 100) / 100;

    const bill = await PurchaseBill.create({
      supplierId: req.supplierId,
      partyId,
      billNumber: billNumber || '',
      billDate: billDate ? new Date(billDate) : new Date(),
      items: cleanItems,
      totalAmount,
      paidAmount: paid,
      paymentType: paymentType || 'Cash',
      balanceDue,
      notes: notes || '',
    });

    // Purchasing stock increases the linked product's stock — this is what "purchase logic" means:
    // buying raw material/stock adds to what you have on hand to sell.
    for (const it of cleanItems) {
      if (it.productId) {
        await Product.findByIdAndUpdate(it.productId, { $inc: { stock: it.quantity } });
      }
    }

    // Update the vendor's running balance — what we still owe them.
    party.balance = Math.round((party.balance + balanceDue) * 100) / 100;
    await party.save();

    res.json(bill);
  } catch (err) {
    console.error('Create purchase bill error:', err);
    res.status(500).json({ error: 'Failed to create purchase bill' });
  }
});

// ================= REPORTS =================

app.get('/api/reports/summary', authMiddleware, async (req, res) => {
  try {
    const supplierId = req.supplierId;

    // Parse date range — defaults to all-time if not provided.
    const { from, to } = req.query;
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999); // include the whole "to" day
      dateFilter.$lte = toDate;
    }
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    // ---- Sales report (from Orders) ----
    const orderMatch = { supplierId, ...(hasDateFilter ? { orderDate: dateFilter } : {}) };
    const orders = await Order.find(orderMatch);
    const validOrders = orders.filter((o) => o.status !== 'cancelled');
    const salesReport = {
      totalOrders: validOrders.length,
      totalRevenue: Math.round(validOrders.reduce((s, o) => s + o.totalAmount, 0) * 100) / 100,
      byStatus: ['pending', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'].map((status) => ({
        status,
        count: orders.filter((o) => o.status === status).length,
      })),
    };

    // ---- Purchase report (from PurchaseBills) ----
    const billMatch = { supplierId, ...(hasDateFilter ? { billDate: dateFilter } : {}) };
    const bills = await PurchaseBill.find(billMatch);
    const purchaseReport = {
      totalBills: bills.length,
      totalPurchaseAmount: Math.round(bills.reduce((s, b) => s + b.totalAmount, 0) * 100) / 100,
      totalPaid: Math.round(bills.reduce((s, b) => s + b.paidAmount, 0) * 100) / 100,
      totalOutstanding: Math.round(bills.reduce((s, b) => s + b.balanceDue, 0) * 100) / 100,
    };

    // ---- Stock / Inventory report (current snapshot — not date-filtered, stock has no history) ----
    const products = await Product.find({ supplierId });
    const stockReport = {
      totalProducts: products.length,
      totalStockUnits: products.reduce((s, p) => s + (p.stock || 0), 0),
      outOfStock: products.filter((p) => (p.stock || 0) === 0).length,
      lowStock: products.filter((p) => (p.stock || 0) > 0 && (p.stock || 0) <= 5).length,
    };

    // ---- Party-wise balance report (current snapshot) ----
    const parties = await Party.find({ supplierId }).sort({ balance: -1 });
    const partyReport = {
      totalParties: parties.length,
      totalOutstanding: Math.round(parties.reduce((s, p) => s + Math.max(0, p.balance), 0) * 100) / 100,
      parties: parties.map((p) => ({ id: p._id.toString(), name: p.name, balance: p.balance })),
    };

    res.json({
      range: { from: from || null, to: to || null },
      sales: salesReport,
      purchase: purchaseReport,
      stock: stockReport,
      parties: partyReport,
    });
  } catch (err) {
    console.error('Reports summary error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ================= PAYMENTS =================

// Supplier: payments summary + list of orders with payment status
app.get('/api/payments', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ supplierId: req.supplierId, status: { $in: ['delivered', 'shipped', 'packed'] } })
      .sort({ createdAt: -1 });

    const paid = orders.filter(o => o.paymentStatus === 'paid');
    const pending = orders.filter(o => o.paymentStatus === 'pending');

    res.json({
      totalPaid: paid.reduce((sum, o) => sum + o.totalAmount, 0),
      totalPending: pending.reduce((sum, o) => sum + o.totalAmount, 0),
      orders: orders.map(safeOrder),
    });
  } catch (err) {
    console.error('Payments error:', err);
    res.status(500).json({ error: 'Failed to load payments' });
  }
});

// ================= WAREHOUSE =================

// Supplier: warehouse view (orders needing packing/location assignment)
app.get('/api/warehouse', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ supplierId: req.supplierId, status: { $in: ['pending', 'packed'] } })
      .sort({ createdAt: -1 });
    res.json(orders.map(safeOrder));
  } catch (err) {
    console.error('Warehouse error:', err);
    res.status(500).json({ error: 'Failed to load warehouse data' });
  }
});

// Supplier: assign a warehouse location to an order
app.put('/api/warehouse/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    order.warehouseLocation = req.body.warehouseLocation || '';
    await order.save();
    res.json(safeOrder(order));
  } catch (err) {
    console.error('Warehouse update error:', err);
    res.status(500).json({ error: 'Failed to update warehouse location' });
  }
});

// ================= PROMOTIONS =================

// Supplier: list own products with featured status
app.get('/api/promotions', authMiddleware, async (req, res) => {
  try {
    const mine = await Product.find({ supplierId: req.supplierId }).sort({ createdAt: -1 });
    res.json(mine.map(p => safeProduct(p)));
  } catch (err) {
    console.error('Promotions error:', err);
    res.status(500).json({ error: 'Failed to load promotions' });
  }
});

// Supplier: toggle featured status on a product
app.put('/api/promotions/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    product.featured = !!req.body.featured;
    await product.save();
    res.json(safeProduct(product));
  } catch (err) {
    console.error('Update promotion error:', err);
    res.status(500).json({ error: 'Failed to update promotion' });
  }
});

// ================= ADVERTISEMENT =================

// Supplier: list own products with ad status
app.get('/api/advertisement', authMiddleware, async (req, res) => {
  try {
    const mine = await Product.find({ supplierId: req.supplierId }).sort({ createdAt: -1 });
    res.json(mine.map(p => safeProduct(p)));
  } catch (err) {
    console.error('Advertisement error:', err);
    res.status(500).json({ error: 'Failed to load advertisement data' });
  }
});

// Supplier: create/update an ad campaign (budget) for a product
app.put('/api/advertisement/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (req.body.adBudget !== undefined) product.adBudget = Number(req.body.adBudget);
    if (req.body.adActive !== undefined) product.adActive = !!req.body.adActive;
    await product.save();
    res.json(safeProduct(product));
  } catch (err) {
    console.error('Update advertisement error:', err);
    res.status(500).json({ error: 'Failed to update advertisement' });
  }
});

// ================= INFLUENCER MARKETING =================

// Supplier: list own products with influencer notes
app.get('/api/influencer-marketing', authMiddleware, async (req, res) => {
  try {
    const mine = await Product.find({ supplierId: req.supplierId }).sort({ createdAt: -1 });
    res.json(mine.map(p => safeProduct(p)));
  } catch (err) {
    console.error('Influencer marketing error:', err);
    res.status(500).json({ error: 'Failed to load influencer marketing data' });
  }
});

// Supplier: save an influencer brief/note for a product
app.put('/api/influencer-marketing/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, supplierId: req.supplierId });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    product.influencerNote = req.body.influencerNote || '';
    await product.save();
    res.json(safeProduct(product));
  } catch (err) {
    console.error('Update influencer note error:', err);
    res.status(500).json({ error: 'Failed to update influencer note' });
  }
});

// ================= INSTANT CASH =================

// Supplier: available balance (pending payouts) + past requests
app.get('/api/instant-cash', authMiddleware, async (req, res) => {
  try {
    const pendingOrders = await Order.find({
      supplierId: req.supplierId,
      status: { $in: ['delivered', 'shipped', 'packed'] },
      paymentStatus: 'pending',
    });
    const availableBalance = pendingOrders.reduce((sum, o) => sum + o.totalAmount, 0);

    const requests = await InstantCashRequest.find({ supplierId: req.supplierId }).sort({ createdAt: -1 });
    res.json({
      availableBalance,
      requests: requests.map(r => {
        const o = r.toObject();
        const { __v, _id, supplierId, ...rest } = o;
        return { ...rest, id: _id.toString() };
      }),
    });
  } catch (err) {
    console.error('Instant cash error:', err);
    res.status(500).json({ error: 'Failed to load instant cash data' });
  }
});

// Supplier: request an instant cash advance
app.post('/api/instant-cash/request', authMiddleware, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });

    const request = await InstantCashRequest.create({
      supplierId: req.supplierId,
      amount,
      note: req.body.note || '',
    });
    const o = request.toObject();
    const { __v, _id, supplierId, ...rest } = o;
    res.json({ ...rest, id: _id.toString() });
  } catch (err) {
    console.error('Instant cash request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ================= DEMO SEED (for showing the dashboard with realistic data) =================

// Supplier: generate demo orders against their own real products, so Orders/Returns/
// Claims/Payments/Warehouse/Inventory pages have something real to show in a demo.
// Safe to call multiple times — only adds data, never touches existing orders.
app.post('/api/demo/seed-orders', authMiddleware, async (req, res) => {
  try {
    const myProducts = await Product.find({ supplierId: req.supplierId });
    if (myProducts.length === 0) {
      return res.status(400).json({ error: 'Add at least one product before seeding demo orders' });
    }

    const buyerNames = ['Priya Sharma', 'Rahul Verma', 'Anjali Nair', 'Karthik Rao', 'Sneha Iyer'];
    const cities = ['Bengaluru, KA 560001', 'Pune, MH 411001', 'Surat, GJ 395007', 'Jaipur, RJ 302001', 'Lucknow, UP 226001'];
    const statuses = ['pending', 'packed', 'shipped', 'delivered'];

    const seeded = [];
    for (let i = 0; i < 6; i++) {
      const product = myProducts[i % myProducts.length];
      const size = (product.sizeStock && product.sizeStock[0]) ? product.sizeStock[0].size : 'M';
      const status = statuses[i % statuses.length];
      const order = await Order.create({
        supplierId: req.supplierId,
        items: [{
          productId: product._id,
          title: product.title,
          imageUrl: product.imageUrl,
          size,
          quantity: 1 + (i % 3),
          price: product.price,
        }],
        totalAmount: product.price * (1 + (i % 3)),
        buyerName: buyerNames[i % buyerNames.length],
        buyerMobile: '98' + (10000000 + i * 137).toString().slice(0, 8),
        shippingAddress: cities[i % cities.length],
        shippingPincode: cities[i % cities.length].match(/\d{6}/)?.[0] || '',
        status,
        paymentStatus: status === 'delivered' ? 'paid' : 'pending',
        paidAt: status === 'delivered' ? new Date() : null,
        returnRequested: i === 5,
        returnReason: i === 5 ? 'Size did not fit' : '',
        returnStatus: i === 5 ? 'requested' : 'none',
      });
      seeded.push(order);
    }

    res.json({ seeded: seeded.length });
  } catch (err) {
    console.error('Seed orders error:', err);
    res.status(500).json({ error: 'Failed to seed demo orders' });
  }
});

// Supplier: dashboard summary (Home screen stats)
app.get('/api/dashboard/summary', authMiddleware, async (req, res) => {
  try {
    const mine = await Product.find({ supplierId: req.supplierId });

    const totalProducts = mine.length;
    const liveProducts = mine.filter(p => p.status === 'live').length;
    const hiddenProducts = mine.filter(p => p.status !== 'live').length;
    const outOfStock = mine.filter(p => (p.stock || 0) === 0).length;
    const lowStock = mine.filter(p => (p.stock || 0) > 0 && (p.stock || 0) <= 5).length;
    const totalStock = mine.reduce((sum, p) => sum + (p.stock || 0), 0);

    const pendingOrders = await Order.countDocuments({ supplierId: req.supplierId, status: 'pending' });

    res.json({
      totalProducts,
      liveProducts,
      hiddenProducts,
      outOfStock,
      lowStock,
      totalStock,
      pendingOrders,
      viewsToday: 0, // no analytics/view-tracking system exists yet
      ordersToday: 0, // no analytics/view-tracking system exists yet
    });
  } catch (err) {
    console.error('Dashboard summary error:', err);
    res.status(500).json({ error: 'Failed to load dashboard summary' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Supplier backend running on http://localhost:${PORT}`);
  });
});
