const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  title: { type: String, required: true }, // snapshot at time of order, survives product edits/deletes
  imageUrl: { type: String, default: null },
  size: { type: String, required: true },
  quantity: { type: Number, required: true, default: 1 },
  price: { type: Number, required: true }, // per-unit price at time of order
}, { _id: false });

const orderSchema = new mongoose.Schema({
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },

  items: { type: [orderItemSchema], required: true },
  totalAmount: { type: Number, required: true },

  buyerName: { type: String, required: true },
  buyerMobile: { type: String, required: true },
  shippingAddress: { type: String, required: true },
  shippingPincode: { type: String, default: '' },

  // Order lifecycle
  status: {
    type: String,
    enum: ['pending', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'],
    default: 'pending',
  },

  // Returns / Claims
  returnRequested: { type: Boolean, default: false },
  returnReason: { type: String, default: '' },
  returnStatus: { type: String, enum: ['none', 'requested', 'approved', 'rejected', 'completed'], default: 'none' },

  claimRaised: { type: Boolean, default: false },
  claimReason: { type: String, default: '' },
  claimStatus: { type: String, enum: ['none', 'open', 'resolved', 'rejected'], default: 'none' },

  // Payment / payout tracking
  paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  paidAt: { type: Date, default: null },

  // Warehouse / packaging
  warehouseLocation: { type: String, default: '' },
  labelDownloaded: { type: Boolean, default: false },

  orderDate: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
