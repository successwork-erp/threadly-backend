const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { connectDB } = require('./mongo');
const Supplier = require('./models/Supplier');
const Product = require('./models/Product');
const Order = require('./models/Order');
const InstantCashRequest = require('./models/InstantCashRequest');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'demo-secret-change-in-production';

app.use(cors());
app.use(express.json());

// ---- File uploads (product images) ----
// NOTE: Render's free tier wipes local disk on every restart/redeploy, so uploaded
// images will still be lost even though supplier/product DATA is now safe in MongoDB.
// Fine for a demo. Before going to real suppliers, move this to Cloudinary/S3 (see README Part 5).
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname)),
});
const upload = multer({ storage });

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

    const imageUrls = (req.files && req.files.length > 0) ? req.files.map(f => '/uploads/' + f.filename) : [];

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

    const newUrls = req.files.map(f => '/uploads/' + f.filename);
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
