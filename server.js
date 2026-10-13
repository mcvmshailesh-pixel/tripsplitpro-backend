const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');

dotenv.config();
const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Health Check Route
app.get('/api/health', (req, res) => {
  res.json({ status: 'success', message: 'TripSplit Pro API is running perfectly!' });
});

// Root Route (Stops the "Cannot GET /" error)
app.get('/', (req, res) => {
  res.send('Welcome to the TripSplit Pro Backend API');
});

// Connect the Auth Routes
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// --- NEW CODE: Connect the Trips Routes ---
const tripRoutes = require('./routes/trips');
app.use('/api/trips', tripRoutes);
// ------------------------------------------

// --- NEW CODE: Connect the Expenses Routes ---
const expenseRoutes = require('./routes/expenses');
app.use('/api/expenses', expenseRoutes);
// ---------------------------------------------

// --- NEW CODE: Connect the Admin Routes ---
const adminRoutes = require('./routes/admin');
app.use('/api/admin', adminRoutes);
// ------------------------------------------

// Connect the Advances Routes
const advanceRoutes = require('./routes/advances');
app.use('/api/advances', advanceRoutes);

// Connect the Petty Cash Routes
const pettyCashRoutes = require('./routes/pettycash');
app.use('/api/petty-cash', pettyCashRoutes);

// Connect the Notifications Routes
const notificationRoutes = require('./routes/notifications');
app.use('/api/notifications', notificationRoutes);

// Connect the Categories Routes
const categoryRoutes = require('./routes/categories');
app.use('/api/categories', categoryRoutes);

// Connect the Locations & Destinations Routes
const locationRoutes = require('./routes/locations');
app.use('/api/locations', locationRoutes);


// Start the Server
const PORT = process.env.PORT || 5000;

const bcrypt = require('bcryptjs');

async function seedDatabase() {
  try {
    const passwordHash = await bcrypt.hash('password123', 10);
    const adminPasswordHash = await bcrypt.hash('admin12345', 10);

    const defaultUsers = [
      { email: 'demo@example.com', name: 'Demo User', mobile: '9999999999', passwordHash, role: 'USER' },
      { email: 'admin@example.com', name: 'Admin User', mobile: '1111111111', passwordHash: adminPasswordHash, role: 'ADMIN' },
      { email: 'rahul@example.com', name: 'Rahul Sharma', mobile: '9876543210', passwordHash, role: 'USER' },
      { email: 'amit@example.com', name: 'Amit Kumar', mobile: '9998887776', passwordHash, role: 'USER' },
      { email: 'vinit@example.com', name: 'Vinit Kumar', mobile: '1232323321', passwordHash, role: 'USER' },
    ];

    for (const u of defaultUsers) {
      await prisma.user.upsert({
        where: { email: u.email },
        update: {},
        create: u,
      });
    }
    console.log('✅ Default users seeded successfully.');

    // Seed default categories
    const defaultCategories = [
      { name: 'Food', icon: 'utensils', color: '#FF5733', sortOrder: 1 },
      { name: 'Hotel', icon: 'hotel', color: '#33C1FF', sortOrder: 2 },
      { name: 'Transport', icon: 'bus', color: '#33FF57', sortOrder: 3 },
      { name: 'Fuel', icon: 'fuel', color: '#F0FF33', sortOrder: 4 },
      { name: 'Shopping', icon: 'shopping-bag', color: '#FF33F6', sortOrder: 5 },
      { name: 'Entertainment', icon: 'film', color: '#AF33FF', sortOrder: 6 },
      { name: 'Medical', icon: 'heart-pulse', color: '#FF3333', sortOrder: 7 },
      { name: 'Flight', icon: 'plane', color: '#33FFAF', sortOrder: 8 },
      { name: 'Train', icon: 'train', color: '#FF8E33', sortOrder: 9 },
      { name: 'Taxi', icon: 'car', color: '#FFE333', sortOrder: 10 },
      { name: 'Local Travel', icon: 'map-pin', color: '#337BFF', sortOrder: 11 },
      { name: 'Miscellaneous', icon: 'archive', color: '#8E8E8E', sortOrder: 12 },
      { name: 'Payment', icon: 'credit-card', color: '#28a745', sortOrder: 13 },
    ];

    for (const c of defaultCategories) {
      await prisma.category.upsert({
        where: { name: c.name },
        update: {},
        create: c
      });
    }
    console.log('✅ Default categories seeded successfully.');
  } catch (err) {
    console.error('❌ Database seeding failed:', err);
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  await seedDatabase();
});