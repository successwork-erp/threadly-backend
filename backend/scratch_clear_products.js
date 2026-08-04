require('dotenv').config();
const { connectDB } = require('./mongo');
const Product = require('./models/Product');

async function clear() {
  await connectDB();
  try {
    const result = await Product.deleteMany({});
    console.log(`Successfully deleted ${result.deletedCount} products from the database.`);
  } catch (err) {
    console.error('Failed to clear products:', err);
  } finally {
    process.exit(0);
  }
}

clear();
