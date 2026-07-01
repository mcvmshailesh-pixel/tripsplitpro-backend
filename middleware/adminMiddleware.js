const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

module.exports = async function (req, res, next) {
  // authMiddleware sets req.user to the decoded JWT payload (which contains user id)
  if (!req.user || !req.user.id) {
    return res.status(401).json({ message: 'No authorization token, access denied' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { role: true }
    });

    if (!user || user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Access denied. Administrator privileges required.' });
    }

    next();
  } catch (error) {
    console.error('Error in adminMiddleware:', error);
    res.status(500).json({ message: 'Server error during admin authorization check' });
  }
};
