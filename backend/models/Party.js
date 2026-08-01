const mongoose = require('mongoose');

// A "Party" here is a vendor/supplier the SELLER buys raw materials or stock from —
// not a buyer. Buyers already have their own Buyer model. This mirrors the "Parties"
// concept from the Successworks ERP app, scoped per-supplier.
const partySchema = new mongoose.Schema({
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },

  name: { type: String, required: true },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  gstin: { type: String, default: '' },
  address: { type: String, default: '' },

  // Running balance: positive = we owe them money (unpaid purchases), negative = we've overpaid/credit.
  balance: { type: Number, default: 0 },

  notes: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Party', partySchema);
