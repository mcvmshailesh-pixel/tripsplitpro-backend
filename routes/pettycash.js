const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/authMiddleware');
const tripAuthMiddleware = require('../middleware/tripAuthMiddleware');

const router = express.Router();
const prisma = new PrismaClient();

// GET: Fetch all cash transactions for a trip (Protected)
router.get('/trip/:tripId', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  try {
    const txs = await prisma.pettyCashTransaction.findMany({
      where: { tripId },
      include: {
        cashHolder: { select: { id: true, name: true } },
        fundedBy: { select: { id: true, name: true } },
        expense: { select: { id: true, description: true } }
      },
      orderBy: { date: 'desc' }
    });
    res.json(txs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching petty cash transactions.' });
  }
});

// GET: Fetch detailed ledger & metrics (Protected)
router.get('/trip/:tripId/ledger', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  try {
    const txs = await prisma.pettyCashTransaction.findMany({
      where: { tripId },
      include: {
        cashHolder: { select: { id: true, name: true } },
        fundedBy: { select: { id: true, name: true } }
      },
      orderBy: { date: 'asc' } // chronological order for ledger running balance
    });

    // Calculate Cash in Hand for each participant
    const cashInHand = {};
    const ledger = txs.map(tx => {
      const holderId = tx.cashHolderId;
      if (cashInHand[holderId] === undefined) {
        cashInHand[holderId] = 0;
      }
      cashInHand[holderId] += tx.amountAdded - tx.amountWithdrawn;
      
      return {
        ...tx,
        runningBalance: cashInHand[holderId]
      };
    });

    // Reverse for UI display (most recent first)
    ledger.reverse();

    // Summary metrics
    const totalAdded = txs.reduce((sum, t) => sum + t.amountAdded, 0);
    const totalWithdrawn = txs.reduce((sum, t) => sum + t.amountWithdrawn, 0);
    const currentBalance = totalAdded - totalWithdrawn;

    res.json({
      summary: {
        totalAdded,
        totalWithdrawn,
        currentBalance,
        cashInHandByHolder: cashInHand
      },
      ledger
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while calculating petty cash ledger.' });
  }
});

// POST: Add a cash transaction or perform a cash transfer (Protected)
router.post('/', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId, cashHolderId, fundedById, amountAdded, amountWithdrawn, purpose, remarks, isTransfer, transferToId, amount } = req.body;
  try {
    const trip = req.trip;

    // Check if trip is closed
    if (trip.status === 'CLOSED') {
      return res.status(400).json({ message: 'Cannot add cash transactions to a closed trip.' });
    }

    if (isTransfer) {
      // 1. CASH TRANSFER BETWEEN MEMBERS
      const transferAmount = parseFloat(amount);
      if (isNaN(transferAmount) || transferAmount <= 0) {
        return res.status(400).json({ message: 'Transfer amount must be a positive number.' });
      }

      const senderId = cashHolderId || req.user.id;
      const receiverId = transferToId;

      if (senderId === receiverId) {
        return res.status(400).json({ message: 'Cannot transfer cash to yourself.' });
      }

      // Check if receiver is in the system
      const receiver = await prisma.user.findUnique({ where: { id: receiverId } });
      if (!receiver) {
        return res.status(404).json({ message: 'Receiver not found.' });
      }

      // Check if sender has enough cash-in-hand
      const senderTxs = await prisma.pettyCashTransaction.findMany({
        where: { tripId, cashHolderId: senderId }
      });
      const senderCash = senderTxs.reduce((sum, t) => sum + t.amountAdded - t.amountWithdrawn, 0);

      if (senderCash < transferAmount) {
        return res.status(400).json({
          message: `Insufficient cash in hand! Sender has only ₹${senderCash.toFixed(2)} but trying to transfer ₹${transferAmount.toFixed(2)}.`
        });
      }

      // Fetch names for description
      const sender = await prisma.user.findUnique({ where: { id: senderId } });

      // Create double-entry transfer transactions
      await prisma.$transaction([
        // Withdrawal from Sender
        prisma.pettyCashTransaction.create({
          data: {
            tripId,
            cashHolderId: senderId,
            amountWithdrawn: transferAmount,
            purpose: `Transfer to ${receiver.name}`,
            remarks: remarks || `Cash transfer from ${sender.name} to ${receiver.name}`
          }
        }),
        // Addition to Receiver
        prisma.pettyCashTransaction.create({
          data: {
            tripId,
            cashHolderId: receiverId,
            amountAdded: transferAmount,
            purpose: `Transfer from ${sender.name}`,
            remarks: remarks || `Cash transfer from ${sender.name} to ${receiver.name}`
          }
        })
      ]);

      return res.status(201).json({ message: 'Cash transfer completed successfully.' });
    }

    // 2. NORMAL ADDITION / WITHDRAWAL
    const valAdded = parseFloat(amountAdded) || 0;
    const valWithdrawn = parseFloat(amountWithdrawn) || 0;

    if (valAdded < 0 || valWithdrawn < 0) {
      return res.status(400).json({ message: 'Amounts cannot be negative.' });
    }

    if (valAdded === 0 && valWithdrawn === 0) {
      return res.status(400).json({ message: 'Must specify addition or withdrawal amount.' });
    }

    const holderId = cashHolderId || req.user.id;

    // If withdrawing, check current cash-in-hand for this holder
    if (valWithdrawn > 0) {
      const currentTxs = await prisma.pettyCashTransaction.findMany({
        where: { tripId, cashHolderId: holderId }
      });
      const currentCash = currentTxs.reduce((sum, t) => sum + t.amountAdded - t.amountWithdrawn, 0);

      if (currentCash < valWithdrawn) {
        return res.status(400).json({
          message: `Insufficient cash in hand! Cash holder has only ₹${currentCash.toFixed(2)} but trying to withdraw ₹${valWithdrawn.toFixed(2)}.`
        });
      }
    }

    const tx = await prisma.pettyCashTransaction.create({
      data: {
        tripId,
        cashHolderId: holderId,
        fundedById: valAdded > 0 ? (fundedById || req.user.id) : null,
        amountAdded: valAdded,
        amountWithdrawn: valWithdrawn,
        purpose: purpose || (valAdded > 0 ? 'Cash Top-up' : 'Cash Expense'),
        remarks
      },
      include: {
        cashHolder: { select: { name: true } }
      }
    });

    // Check for Low Cash Alert (less than ₹500)
    if (valWithdrawn > 0) {
      const postTxs = await prisma.pettyCashTransaction.findMany({
        where: { tripId, cashHolderId: holderId }
      });
      const postCash = postTxs.reduce((sum, t) => sum + t.amountAdded - t.amountWithdrawn, 0);

      if (postCash < 500) {
        // Send notification to the cash holder
        await prisma.notification.create({
          data: {
            userId: holderId,
            title: 'Low Cash Alert ⚠️',
            message: `Your cash in hand for this trip is low. Remaining balance: ₹${postCash.toFixed(2)}.`,
            type: 'WARNING'
          }
        });
      }
    }

    res.status(201).json({ message: 'Petty cash transaction recorded successfully.', transaction: tx });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while adding petty cash transaction.' });
  }
});

module.exports = router;
