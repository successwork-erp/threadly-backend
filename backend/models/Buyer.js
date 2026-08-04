const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  productId: { type: String, required: true },
  name: { type: String, default: '' },
  price: { type: String, default: '0' },
  originalPrice: { type: String, default: '0' },
  emoji: { type: String, default: '🛍️' },
  size: { type: String, default: 'M' },
  color: { type: String, default: 'Default' },
  imageUrl: { type: String, default: '' },
  quantity: { type: Number, default: 1, min: 1 },
}, { _id: false });

const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, default: '' },
  type: { type: String, default: 'general' }, // order | promo | general | earning
  orderId: { type: String, default: '' },
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const buyerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  mobile: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true }, // bcrypt hash
  securityQuestion: { type: String, default: null },
  securityAnswer: { type: String, default: null }, // bcrypt hash of lowercased answer
  addresses: {
    type: [{
      label: { type: String, default: 'Home' },
      name: { type: String, default: '' },
      mobile: { type: String, default: '' },
      address: { type: String, required: true },
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      pincode: { type: String, default: '' },
    }],
    default: [],
  },
  cart: { type: [cartItemSchema], default: [] },
  wishlist: { type: [String], default: [] }, // product id strings
  notifications: { type: [notificationSchema], default: [] },
  approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  catalogIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'Catalog', default: [] },
}, { timestamps: true });

module.exports = mongoose.model('Buyer', buyerSchema);
