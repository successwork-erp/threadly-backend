const mongoose = require('mongoose');

const sizeStockSchema = new mongoose.Schema({
  size: String,
  stock: Number,
}, { _id: false });

const productSchema = new mongoose.Schema({
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  category: { type: String, default: 'T-Shirt' },

  // Product, Size and Inventory
  gst: { type: String, default: '' },
  hsnCode: { type: String, default: '' },
  netWeight: { type: String, default: '' },
  styleCode: { type: String, default: '' },
  title: { type: String, required: true },
  price: { type: Number, required: true },
  mrp: { type: Number },

  // Product Details
  color: { type: [String], default: [] },
  fabric: { type: String, default: '' },
  fitShape: { type: String, default: '' },
  genericName: { type: String, default: '' },
  netQuantity: { type: String, default: '1' },
  neck: { type: String, default: '' },
  occasion: { type: String, default: '' },
  pattern: { type: String, default: '' },
  printOrPatternType: { type: String, default: '' },
  sleeveLength: { type: String, default: '' },
  countryOfOrigin: { type: String, default: 'India' },

  // Manufacturer / Packer / Importer
  manufacturerName: { type: String, default: '' },
  manufacturerAddress: { type: String, default: '' },
  manufacturerPincode: { type: String, default: '' },
  packerName: { type: String, default: '' },
  packerAddress: { type: String, default: '' },
  packerPincode: { type: String, default: '' },
  importerName: { type: String, default: '' },
  importerAddress: { type: String, default: '' },
  importerPincode: { type: String, default: '' },

  // Other Attributes
  brand: { type: String, default: '' },
  character: { type: String, default: '' },
  hemline: { type: String, default: '' },
  length: { type: String, default: '' },
  numberOfPockets: { type: String, default: '' },
  sleeveStyling: { type: String, default: '' },
  style: { type: String, default: '' },
  description: { type: String, default: '' },

  // Sizes and stock
  sizeStock: { type: [sizeStockSchema], default: [{ size: 'M', stock: 0 }] },
  stock: { type: Number, default: 0 },

  // Images
  imageUrls: { type: [String], default: [] },
  imageUrl: { type: String, default: null },

  status: { type: String, default: 'live' },

  // Marketing / growth features
  featured: { type: Boolean, default: false }, // "Promotions" — boosted visibility
  adBudget: { type: Number, default: 0 }, // "Advertisement" — daily ad spend supplier has set
  adActive: { type: Boolean, default: false },
  influencerNote: { type: String, default: '' }, // "Influencer Marketing" — supplier's brief/notes for influencers
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
