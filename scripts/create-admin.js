const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

(async () => {
  try {
    const passwordHash = await bcrypt.hash('admin12345', 10);

    const user = await prisma.user.upsert({
      where: { email: 'admin@example.com' },
      update: {
        name: 'Admin User',
        passwordHash,
        mobile: '1111111111',
      },
      create: {
        name: 'Admin User',
        email: 'admin@example.com',
        mobile: '1111111111',
        passwordHash,
      },
    });

    console.log(JSON.stringify({ email: user.email, name: user.name, id: user.id }, null, 2));
  } catch (error) {
    console.error(error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
