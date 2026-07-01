const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const email = 'admin@example.com';
  console.log(`Checking admin status for: ${email}`);
  
  try {
    const existingAdmin = await prisma.user.findUnique({ where: { email } });
    if (existingAdmin) {
      console.log("Admin user exists. Updating role to ADMIN...");
      const updated = await prisma.user.update({
        where: { email },
        data: { role: 'ADMIN' }
      });
      console.log("Success! Updated user:", updated);
    } else {
      console.log("Admin user does not exist. Creating admin user...");
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash('password123', salt);
      
      const newUser = await prisma.user.create({
        data: {
          name: 'Admin User',
          email,
          mobile: '1111111111',
          passwordHash,
          role: 'ADMIN'
        }
      });
      console.log("Success! Created user:", newUser);
    }
  } catch (err) {
    console.error("Error setting up admin user:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
