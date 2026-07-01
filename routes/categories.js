const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();
const prisma = new PrismaClient();

// GET: Fetch all active categories (Protected)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { isEnabled: true, isDeleted: false },
      orderBy: { sortOrder: 'asc' }
    });
    res.json(categories);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching categories.' });
  }
});

module.exports = router;
