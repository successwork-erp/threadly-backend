const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { loadDB, saveDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = 'demo-secret-change-in-production';

app.use(cors());
app.use(express.json());

// ---- File uploads (product images) ----
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
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

// ================= SUPPLIER AUTH =================

// Register supplier
app.post('/api/auth/register', async (req, res) => {
  const { name, email, mobile, password, securityQuestion, securityAnswer } = req.body;
  if (!name || !email || !mobile || !password) {
    return res.status(400).json({ error: 'Name, email, mobile and password are required' });
  }
  const db = loadDB();
  const exists = db.suppliers.find(s => s.email === email || s.mobile === mobile);
  if (exists) return res.status(409).json({ error: 'Supplier with this email or mobile already exists' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const supplier = {
    id: uuidv4(),
    name,
    email,
    mobile,
    password: hashedPassword,
    securityQuestion: securityQuestion || null,
    securityAnswer: securityAnswer || null,
    businessName: null,
    createdAt: new Date().toISOString(),
  };
  db.suppliers.push(supplier);
  saveDB(db);

  const token = jwt.sign({ id: supplier.id }, JWT_SECRET, { expiresIn: '7d' });
  const { password: _pw, securityAnswer: _sa, ...safeSupplier } = supplier;
  res.json({ token, supplier: safeSupplier });
});

// Login supplier
app.post('/api/auth/login', async (req, res) => {
  const { emailOrMobile, password } = req.body;
  const db = loadDB();
  const supplier = db.suppliers.find(s => s.email === emailOrMobile || s.mobile === emailOrMobile);
  if (!supplier) return res.status(404).json({ error: 'No account found with this email/mobile' });

  const match = await bcrypt.compare(password, supplier.password);
  if (!match) return res.status(401).json({ error: 'Incorrect password' });

  const token = jwt.sign({ id: supplier.id }, JWT_SECRET, { expiresIn: '7d' });
  const { password: _pw, securityAnswer: _sa, ...safeSupplier } = supplier;
  res.json({ token, supplier: safeSupplier });
});

// Get current supplier profile
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const db = loadDB();
  const supplier = db.suppliers.find(s => s.id === req.supplierId);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  const { password: _pw, securityAnswer: _sa, ...safeSupplier } = supplier;
  res.json(safeSupplier);
});

// ================= PRODUCTS =================

// Public: list all products (this is what the mobile app polls)
app.get('/api/products', (req, res) => {
  const db = loadDB();
  const products = db.products.map(p => {
    const supplier = db.suppliers.find(s => s.id === p.supplierId);
    return { ...p, supplierName: supplier ? (supplier.businessName || supplier.name) : 'Unknown' };
  });
  res.json(products.reverse()); // newest first
});

// Supplier: list own products
app.get('/api/products/mine', authMiddleware, (req, res) => {
  const db = loadDB();
  const mine = db.products.filter(p => p.supplierId === req.supplierId);
  res.json(mine.reverse());
});

// Supplier: add a product (T-shirt) - supports multiple images plus per-size stock
app.post('/api/products', authMiddleware, upload.array('images', 6), (req, res) => {
  const b = req.body;

  if (!b.title || !b.price) return res.status(400).json({ error: 'Title and price are required' });

  let parsedSizeStock = [];
  try {
    parsedSizeStock = b.sizeStock ? JSON.parse(b.sizeStock) : [];
  } catch (e) {
    parsedSizeStock = [];
  }

  const splitList = function(v) {
    return v ? v.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
  };

  const db = loadDB();
  const product = {
    id: uuidv4(),
    supplierId: req.supplierId,
    category: 'T-Shirt',

    // Product, Size and Inventory
    gst: b.gst || '',
    hsnCode: b.hsnCode || '',
    netWeight: b.netWeight || '',
    styleCode: b.styleCode || '',
    title: b.title,
    price: Number(b.price),
    mrp: b.mrp ? Number(b.mrp) : Number(b.price),

    // Product Details
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

    // Manufacturer / Packer / Importer
    manufacturerName: b.manufacturerName || '',
    manufacturerAddress: b.manufacturerAddress || '',
    manufacturerPincode: b.manufacturerPincode || '',
    packerName: b.packerName || '',
    packerAddress: b.packerAddress || '',
    packerPincode: b.packerPincode || '',
    importerName: b.importerName || '',
    importerAddress: b.importerAddress || '',
    importerPincode: b.importerPincode || '',

    // Other Attributes
    brand: b.brand || '',
    character: b.character || '',
    hemline: b.hemline || '',
    length: b.length || '',
    numberOfPockets: b.numberOfPockets || '',
    sleeveStyling: b.sleeveStyling || '',
    style: b.style || '',
    description: b.description || '',

    // Sizes and stock
    sizeStock: parsedSizeStock.length > 0 ? parsedSizeStock : [{ size: 'M', stock: 0 }],
    stock: parsedSizeStock.length > 0
      ? parsedSizeStock.reduce(function(sum, s){ return sum + Number(s.stock || 0); }, 0)
      : 0,

    // Images: Front View, Side View, Back Image, Zoomed In (in upload order)
    imageUrls: (req.files && req.files.length > 0) ? req.files.map(function(f){ return '/uploads/' + f.filename; }) : [],
    imageUrl: (req.files && req.files.length > 0) ? ('/uploads/' + req.files[0].filename) : null,

    status: 'live',
    createdAt: new Date().toISOString(),
  };
  db.products.push(product);
  saveDB(db);
  res.json(product);
});

// Supplier: update a product
app.put('/api/products/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const idx = db.products.findIndex(p => p.id === req.params.id && p.supplierId === req.supplierId);
  if (idx === -1) return res.status(404).json({ error: 'Product not found' });

  const b = req.body;
  const p = db.products[idx];

  const directFields = [
    'gst', 'hsnCode', 'netWeight', 'styleCode', 'title', 'fabric', 'fitShape',
    'genericName', 'netQuantity', 'neck', 'occasion', 'pattern', 'printOrPatternType',
    'sleeveLength', 'countryOfOrigin', 'manufacturerName', 'manufacturerAddress',
    'manufacturerPincode', 'packerName', 'packerAddress', 'packerPincode',
    'importerName', 'importerAddress', 'importerPincode', 'brand', 'character',
    'hemline', 'length', 'numberOfPockets', 'sleeveStyling', 'style', 'description', 'status',
  ];
  directFields.forEach(function(field) {
    if (b[field] !== undefined) p[field] = b[field];
  });

  if (b.price !== undefined) p.price = Number(b.price);
  if (b.mrp !== undefined) p.mrp = Number(b.mrp);
  if (b.color !== undefined) {
    p.color = Array.isArray(b.color) ? b.color : b.color.split(',').map(function(c){ return c.trim(); });
  }
  if (b.sizeStock !== undefined) {
    p.sizeStock = Array.isArray(b.sizeStock) ? b.sizeStock : JSON.parse(b.sizeStock);
    p.stock = p.sizeStock.reduce(function(sum, s){ return sum + Number(s.stock || 0); }, 0);
  }

  db.products[idx] = p;
  saveDB(db);
  res.json(p);
});

// Supplier: delete a product
app.delete('/api/products/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const before = db.products.length;
  db.products = db.products.filter(p => !(p.id === req.params.id && p.supplierId === req.supplierId));
  if (db.products.length === before) return res.status(404).json({ error: 'Product not found' });
  saveDB(db);
  res.json({ success: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Supplier backend running on http://localhost:${PORT}`);
});
