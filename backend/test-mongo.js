import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const testConnection = async () => {
  try {
    console.log('🔍 Testing MongoDB connection...');
    console.log('📝 Connection string:', process.env.MONGO_URI?.replace(/:[^:@]+@/, ':****@'));
    
    await mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 30000,
  connectTimeoutMS: 30000
});
    
    console.log('✅ MongoDB Connected Successfully!');
    console.log('📊 Database:', mongoose.connection.db.databaseName);
    console.log('🔗 Host:', mongoose.connection.host);
    console.log('📍 Port:', mongoose.connection.port);
    
    // List collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('📂 Collections:', collections.map(c => c.name).join(', ') || 'No collections yet');
    
    await mongoose.connection.close();
    console.log('🔌 Connection closed');
    process.exit(0);
  } catch (error) {
    console.error('❌ MongoDB Connection Failed!');
    console.error('Error:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
};

testConnection();
