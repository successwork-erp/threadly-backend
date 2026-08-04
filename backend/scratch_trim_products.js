require('dotenv').config();
const { connectDB } = require('./mongo');
const Product = require('./models/Product');

async function trimProducts() {
  await connectDB();
  const KEEP = 600;
  try {
    const before = await Product.countDocuments();
    console.log('before:', before);

    const keep = await Product.find({})
      .sort({ createdAt: -1 })
      .limit(KEEP)
      .select('_id')
      .lean();
    const keepIds = keep.map((p) => p._id);

    const result = await Product.deleteMany({ _id: { $nin: keepIds } });
    const after = await Product.countDocuments();

    console.log('kept:', keepIds.length);
    console.log('deleted:', result.deletedCount);
    console.log('remaining:', after);
  } catch (err) {
    console.error('Failed:', err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

trimProducts();
