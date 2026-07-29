const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  mobile: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true }, // bcrypt hash
  securityQuestion: { type: String, default: null },
  securityAnswer: { type: String, default: null },
  businessName: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Supplier', supplierSchema);
