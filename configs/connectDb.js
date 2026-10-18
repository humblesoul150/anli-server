const mongoose = require("mongoose");

const connectDb = async (url) => {
  try {
    await mongoose.connect(url);
    console.log("✅ Connected to Anli DB successfully");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    throw err;
  }
};

module.exports = { connectDb };
