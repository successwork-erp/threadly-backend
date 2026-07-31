const mongoose = require('mongoose');

const buyerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  mobile: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true }, // bcrypt hash
  addresses: {
    type: [{
      label: { type: String, default: 'Home' }, // e.g. Home, Work
      address: { type: String, required: true },
      pincode: { type: String, default: '' },
    }],
    default: [],
  },
}, { timestamps: true });

module.exports = mongoose.model('Buyer', buyerSchema);
