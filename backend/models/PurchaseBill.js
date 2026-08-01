const mongoose = require('mongoose');

const purchaseItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null }, // optional link to an existing product
  itemName: { type: String, required: true }, // free-text if not linked to a product (e.g. raw fabric)
  quantity: { type: Number, required: true },
  price: { type: Number, required: true }, // price per unit
  amount: { type: Number, required: true }, // quantity * price
}, { _id: false });

const purchaseBillSchema = new mongoose.Schema({
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  partyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Party', required: true },

  billNumber: { type: String, default: '' }, // vendor's own bill/invoice number, optional
  billDate: { type: Date, default: Date.now },

  items: { type: [purchaseItemSchema], default: [] },

  totalAmount: { type: Number, required: true },
  paidAmount: { type: Number, default: 0 },
  paymentType: { type: String, default: 'Cash' }, // Cash, Bank Transfer, UPI, etc.

  // If unpaid or partially paid, the difference adds to the party's running balance (amount owed).
  balanceDue: { type: Number, default: 0 },

  notes: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('PurchaseBill', purchaseBillSchema);
