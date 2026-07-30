// MongoDB Atlas connection.
// Set MONGODB_URI in your environment (Render → your service → Environment tab).
// Get this URI from MongoDB Atlas → Connect → Drivers → Node.js.

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

async function connectDB() {
  if (!MONGODB_URI) {
    console.error('MONGODB_URI is not set. Add it in Render → Environment, or in a local .env file.');
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = { connectDB };
