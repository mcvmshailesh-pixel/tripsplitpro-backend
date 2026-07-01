const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();
const prisma = new PrismaClient();

// GET: Fetch all notifications for logged-in user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json(notifications);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching notifications.' });
  }
});

// PUT: Mark notification as read
router.put('/:id/read', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const notif = await prisma.notification.findFirst({
      where: { id, userId: req.user.id }
    });

    if (!notif) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    const updated = await prisma.notification.update({
      where: { id },
      data: { isRead: true }
    });

    res.json({ message: 'Notification marked as read.', notification: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while updating notification.' });
  }
});

// PUT: Mark all notifications as read
router.put('/read-all', authMiddleware, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true }
    });
    res.json({ message: 'All notifications marked as read.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while reading all notifications.' });
  }
});

// DELETE: Delete notification
router.delete('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const notif = await prisma.notification.findFirst({
      where: { id, userId: req.user.id }
    });

    if (!notif) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    await prisma.notification.delete({ where: { id } });
    res.json({ message: 'Notification deleted successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while deleting notification.' });
  }
});

module.exports = router;
