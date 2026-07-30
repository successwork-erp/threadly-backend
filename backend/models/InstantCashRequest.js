const mongoose = require('mongoose');

const instantCashRequestSchema = new mongoose.Schema({
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['requested', 'approved', 'rejected', 'disbursed'], default: 'requested' },
  note: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('InstantCashRequest', instantCashRequestSchema);
