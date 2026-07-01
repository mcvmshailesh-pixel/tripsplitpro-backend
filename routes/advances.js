const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/authMiddleware');
const tripAuthMiddleware = require('../middleware/tripAuthMiddleware');

const router = express.Router();
const prisma = new PrismaClient();

// GET: Fetch all advances for a trip (Protected)
router.get('/trip/:tripId', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  try {
    const advances = await prisma.advance.findMany({
      where: { tripId },
      include: {
        user: { select: { id: true, name: true, email: true } }
      },
      orderBy: { date: 'desc' }
    });
    res.json(advances);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching advances.' });
  }
});

// POST: Add a new advance payment (Protected)
router.post('/', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId, userId, amount, paymentMode, referenceNumber, notes, currency } = req.body;
  try {
    const amountVal = parseFloat(amount);
    if (isNaN(amountVal) || amountVal <= 0) {
      return res.status(400).json({ message: 'Amount must be a positive number.' });
    }

    const trip = req.trip; // Cached by tripAuthMiddleware

    // Determine status: if created by the trip creator or an admin, auto-approve it.
    // Otherwise, set to PENDING for creator/admin approval.
    const isCreator = trip.creatorId === req.user.id;
    const isAdmin = req.user.role === 'ADMIN';
    const status = (isCreator || isAdmin) ? 'APPROVED' : 'PENDING';

    const newAdvance = await prisma.advance.create({
      data: {
        tripId,
        userId: userId || req.user.id, // Defaults to logged in user if not specified
        amount: amountVal,
        date: new Date(),
        paymentMode: paymentMode || 'Cash',
        referenceNumber,
        notes,
        currency: currency || trip.currency || 'INR',
        status
      },
      include: {
        user: { select: { name: true, email: true } }
      }
    });

    // Notify trip creator if pending
    if (status === 'PENDING') {
      await prisma.notification.create({
        data: {
          userId: trip.creatorId,
          title: 'New Advance Approval Pending',
          message: `${newAdvance.user.name} logged an advance of ${newAdvance.currency} ${newAdvance.amount} requiring approval.`,
          type: 'INFO'
        }
      });
    }

    res.status(201).json({ message: `Advance logged successfully (${status}).`, advance: newAdvance });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while adding advance.' });
  }
});

// PUT: Approve or reject an advance (Trip Creator / Admin only)
router.put('/:id/status', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'APPROVED' or 'REJECTED'

  if (status !== 'APPROVED' && status !== 'REJECTED') {
    return res.status(400).json({ message: 'Status must be APPROVED or REJECTED' });
  }

  try {
    const advance = await prisma.advance.findUnique({
      where: { id },
      include: { trip: true }
    });

    if (!advance) {
      return res.status(404).json({ message: 'Advance payment not found.' });
    }

    // Verify authorized user: Trip Creator or Admin
    const isCreator = advance.trip.creatorId === req.user.id;
    const isAdmin = req.user.role === 'ADMIN';

    if (!isCreator && !isAdmin) {
      return res.status(403).json({ message: 'Only the trip creator or an administrator can approve advances.' });
    }

    const updatedAdvance = await prisma.advance.update({
      where: { id },
      data: { status }
    });

    // Notify the member who logged it
    await prisma.notification.create({
      data: {
        userId: advance.userId,
        title: `Advance Payment ${status.toLowerCase()}`,
        message: `Your advance payment of ${advance.currency} ${advance.amount} has been ${status.toLowerCase()} by the organizer.`,
        type: status === 'APPROVED' ? 'SUCCESS' : 'WARNING'
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        action: `ADVANCE_${status}`,
        userId: req.user.id,
        details: `Advance payment ${id} of ${advance.amount} for user ID ${advance.userId} was ${status}`
      }
    });

    res.json({ message: `Advance payment ${status.toLowerCase()} successfully.`, advance: updatedAdvance });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during advance status update.' });
  }
});

module.exports = router;
