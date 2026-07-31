const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true }, // one review per order/item
  buyerName: { type: String, required: true },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Buyer', default: null },

  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: '' },
  mediaUrls: { type: [String], default: [] }, // photo/video paths under /uploads

}, { timestamps: true });

module.exports = mongoose.model('Review', reviewSchema);
