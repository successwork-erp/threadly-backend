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
  // New buyers must be approved by a supplier on the web portal before they can log in.
  approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },

  // Which catalogs this buyer can see, granted at approval time. Empty until approved.
  catalogIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'Catalog', default: [] },
}, { timestamps: true });

module.exports = mongoose.model('Buyer', buyerSchema);
