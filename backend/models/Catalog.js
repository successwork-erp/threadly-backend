const mongoose = require('mongoose');

// A Catalog is a named group a supplier creates to segment their product listing —
// e.g. "Catalog 1", "Wholesale Only", "VIP Buyers". Products can belong to one or
// more catalogs; buyers are granted access to one or more catalogs at approval time.
// A buyer only ever sees products in a catalog they've been granted access to.
const catalogSchema = new mongoose.Schema({
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  name: { type: String, required: true },
}, { timestamps: true });

// A supplier shouldn't have two catalogs with the exact same name.
catalogSchema.index({ supplierId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Catalog', catalogSchema);
