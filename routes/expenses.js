const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/authMiddleware');
const tripAuthMiddleware = require('../middleware/tripAuthMiddleware');

const router = express.Router();
const prisma = new PrismaClient();

// POST: Add a new expense to a trip (Protected)
router.post('/', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { 
    tripId, 
    description, 
    amount, 
    date, 
    category, 
    splitMethod, 
    shares,      // Array of { userId, val }
    payers,      // Array of { userId, amountPaid } (optional, if multiple payers)
    isPettyCash, // Boolean: paid from petty cash?
    cashHolderId // User ID of the petty cash holder
  } = req.body;

  try {
    const trip = req.trip; // Cached by tripAuthMiddleware

    // 1. Verify trip is active
    if (trip.status === 'CLOSED') {
      return res.status(400).json({ message: 'Cannot add expenses to a closed trip.' });
    }

    const expenseAmount = parseFloat(amount);
    if (isNaN(expenseAmount) || expenseAmount <= 0) {
      return res.status(400).json({ message: 'Expense amount must be a positive number.' });
    }

    // 2. Validate Payers
    let finalPayers = [];
    if (payers && payers.length > 0) {
      // Multiple Payers
      let totalPaid = 0;
      for (const p of payers) {
        const pAmt = parseFloat(p.amountPaid);
        if (isNaN(pAmt) || pAmt < 0) {
          return res.status(400).json({ message: 'Payer amounts cannot be negative.' });
        }
        totalPaid += pAmt;
        finalPayers.push({ userId: p.userId, amountPaid: pAmt });
      }
      // Check total equals expense amount (using epsilon for floats)
      if (Math.abs(totalPaid - expenseAmount) > 0.01) {
        return res.status(400).json({ message: `Total paid by payers (₹${totalPaid.toFixed(2)}) must equal expense amount (₹${expenseAmount.toFixed(2)})` });
      }
    } else {
      // Single Payer (Defaults to logged-in user or cash holder if petty cash)
      const primaryPayerId = isPettyCash ? (cashHolderId || req.user.id) : req.user.id;
      finalPayers.push({ userId: primaryPayerId, amountPaid: expenseAmount });
    }

    // 3. Validate and Calculate Shares
    if (!shares || shares.length === 0) {
      return res.status(400).json({ message: 'At least one participant must be included in the split.' });
    }

    const method = splitMethod || 'EQUAL';
    let calculatedShares = [];

    if (method === 'EQUAL') {
      const count = shares.length;
      const shareAmt = expenseAmount / count;
      for (const s of shares) {
        calculatedShares.push({ userId: s.userId, amountOwed: shareAmt });
      }
    } else if (method === 'UNEQUAL') {
      let totalOwed = 0;
      for (const s of shares) {
        const owedAmt = parseFloat(s.val);
        if (isNaN(owedAmt) || owedAmt < 0) {
          return res.status(400).json({ message: 'Manual split amounts cannot be negative.' });
        }
        totalOwed += owedAmt;
        calculatedShares.push({ userId: s.userId, amountOwed: owedAmt });
      }
      if (Math.abs(totalOwed - expenseAmount) > 0.01) {
        return res.status(400).json({ message: `Sum of split amounts (₹${totalOwed.toFixed(2)}) must equal expense amount (₹${expenseAmount.toFixed(2)}).` });
      }
    } else if (method === 'PERCENTAGE') {
      let totalPercent = 0;
      for (const s of shares) {
        const pct = parseFloat(s.val);
        if (isNaN(pct) || pct < 0) {
          return res.status(400).json({ message: 'Percentages cannot be negative.' });
        }
        totalPercent += pct;
        const shareAmt = (pct / 100) * expenseAmount;
        calculatedShares.push({ userId: s.userId, amountOwed: shareAmt, metadata: JSON.stringify({ percentage: pct }) });
      }
      if (Math.abs(totalPercent - 100) > 0.01) {
        return res.status(400).json({ message: `Percentages must total exactly 100% (currently ${totalPercent.toFixed(2)}%).` });
      }
    } else if (method === 'WEIGHT') {
      let totalWeight = 0;
      for (const s of shares) {
        const wt = parseFloat(s.val);
        if (isNaN(wt) || wt < 0) {
          return res.status(400).json({ message: 'Weights cannot be negative.' });
        }
        totalWeight += wt;
      }
      if (totalWeight <= 0) {
        return res.status(400).json({ message: 'Total weight must be greater than zero.' });
      }
      for (const s of shares) {
        const wt = parseFloat(s.val);
        const shareAmt = (wt / totalWeight) * expenseAmount;
        calculatedShares.push({ userId: s.userId, amountOwed: shareAmt, metadata: JSON.stringify({ weight: wt }) });
      }
    } else if (method === 'QUANTITY') {
      let totalQty = 0;
      for (const s of shares) {
        const qty = parseFloat(s.val);
        if (isNaN(qty) || qty < 0) {
          return res.status(400).json({ message: 'Quantities cannot be negative.' });
        }
        totalQty += qty;
      }
      if (totalQty <= 0) {
        return res.status(400).json({ message: 'Total quantity must be greater than zero.' });
      }
      for (const s of shares) {
        const qty = parseFloat(s.val);
        const shareAmt = (qty / totalQty) * expenseAmount;
        calculatedShares.push({ userId: s.userId, amountOwed: shareAmt, metadata: JSON.stringify({ quantity: qty }) });
      }
    } else {
      return res.status(400).json({ message: `Unsupported split method: ${method}` });
    }

    // 4. Handle Petty Cash check
    if (isPettyCash) {
      const pHolderId = cashHolderId || req.user.id;
      const currentTxs = await prisma.pettyCashTransaction.findMany({
        where: { tripId, cashHolderId: pHolderId }
      });
      const currentCash = currentTxs.reduce((sum, t) => sum + t.amountAdded - t.amountWithdrawn, 0);

      if (currentCash < expenseAmount) {
        return res.status(400).json({
          message: `Insufficient Petty Cash! Cash holder has only ₹${currentCash.toFixed(2)} but the expense is ₹${expenseAmount.toFixed(2)}.`
        });
      }
    }

    // 5. DB Transaction to create Expense, Payers, Shares, and optionally Petty Cash Transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create Expense
      const expenseObj = await tx.expense.create({
        data: {
          tripId,
          paidById: finalPayers[0].userId, // Primary payer as fallback
          amount: expenseAmount,
          description,
          category: category || 'General',
          date: date ? new Date(date) : new Date(),
          splitMethod: method,
        }
      });

      // Create Payers
      for (const p of finalPayers) {
        await tx.expensePayer.create({
          data: {
            expenseId: expenseObj.id,
            userId: p.userId,
            amountPaid: p.amountPaid
          }
        });
      }

      // Create Shares
      for (const s of calculatedShares) {
        await tx.expenseShare.create({
          data: {
            expenseId: expenseObj.id,
            userId: s.userId,
            amountOwed: s.amountOwed,
            metadata: s.metadata
          }
        });
      }

      // Create Petty Cash transaction if applicable
      if (isPettyCash) {
        await tx.pettyCashTransaction.create({
          data: {
            tripId,
            cashHolderId: cashHolderId || req.user.id,
            amountWithdrawn: expenseAmount,
            purpose: `Expense: ${description}`,
            expenseId: expenseObj.id,
            remarks: `Linked to expense ${expenseObj.id}`
          }
        });
      }

      return expenseObj;
    });

    // Create Notification for trip members
    const creatorName = req.user.name;
    const tripMembers = await prisma.tripMember.findMany({
      where: { tripId },
      include: { user: true }
    });

    const notifyPromises = tripMembers
      .filter(m => m.userId !== req.user.id)
      .map(m => prisma.notification.create({
        data: {
          userId: m.userId,
          title: 'New Expense Added 💸',
          message: `${creatorName} added "${description}" (₹${expenseAmount.toFixed(2)}) to trip "${trip.name}".`,
          type: 'INFO'
        }
      }));
    
    if (trip.creatorId !== req.user.id) {
      notifyPromises.push(prisma.notification.create({
        data: {
          userId: trip.creatorId,
          title: 'New Expense Added 💸',
          message: `${creatorName} added "${description}" (₹${expenseAmount.toFixed(2)}) to trip "${trip.name}".`,
          type: 'INFO'
        }
      }));
    }

    await Promise.all(notifyPromises);

    res.status(201).json({ message: 'Expense added successfully', expense: result });

  } catch (error) {
    console.error('Error while adding expense:', error);
    res.status(500).json({ message: 'Server error while adding expense.' });
  }
});

// GET: Fetch all expenses for a specific trip (Protected)
router.get('/trip/:tripId', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  try {
    const expenses = await prisma.expense.findMany({
      where: { tripId },
      include: {
        paidBy: { select: { id: true, name: true } },
        payers: { include: { user: { select: { id: true, name: true } } } },
        shares: { include: { user: { select: { id: true, name: true } } } }
      },
      orderBy: { date: 'desc' }
    });
    res.json(expenses);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching expenses.' });
  }
});

// GET: Calculate detailed balances for a trip (Protected)
router.get('/trip/:tripId/balances', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  try {
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: { 
        creator: { select: { id: true, name: true } },
        members: { include: { user: { select: { id: true, name: true } } } }
      }
    });

    const expenses = await prisma.expense.findMany({
      where: { tripId },
      include: { payers: true, shares: true }
    });

    const approvedAdvances = await prisma.advance.findMany({
      where: { tripId, status: 'APPROVED' }
    });

    const cashTransactions = await prisma.pettyCashTransaction.findMany({
      where: { tripId }
    });

    const completedSettlements = await prisma.settlement.findMany({
      where: { tripId, status: 'COMPLETED' }
    });

    // 1. Gather all unique participants
    const participants = new Map();
    participants.set(trip.creatorId, { id: trip.creatorId, name: trip.creator.name });
    trip.members.forEach(m => {
      participants.set(m.user.id, { id: m.user.id, name: m.user.name });
    });

    // 2. Initialize balances structure
    const stats = {};
    participants.forEach((p, id) => {
      stats[id] = {
        id,
        name: p.name,
        totalPaid: 0,
        totalOwed: 0,
        advancesPaid: 0,
        pettyCashFunded: 0,
        pettyCashWithdrawn: 0,
        settlementsSent: 0,
        settlementsReceived: 0,
        finalBalance: 0
      };
    });

    // 3. Process expenses
    expenses.forEach(exp => {
      // Calculate Payers Contribution
      if (exp.payers && exp.payers.length > 0) {
        exp.payers.forEach(p => {
          if (stats[p.userId]) stats[p.userId].totalPaid += p.amountPaid;
        });
      } else {
        // Fallback for old EQUAL schema
        if (stats[exp.paidById]) stats[exp.paidById].totalPaid += exp.amount;
      }

      // Calculate Owed Share
      if (exp.shares && exp.shares.length > 0) {
        exp.shares.forEach(s => {
          if (stats[s.userId]) stats[s.userId].totalOwed += s.amountOwed;
        });
      } else {
        // Fallback split equally among all members
        const shareAmt = exp.amount / participants.size;
        participants.forEach((_, id) => {
          if (stats[id]) stats[id].totalOwed += shareAmt;
        });
      }
    });

    // 4. Process Advances (Approved)
    approvedAdvances.forEach(adv => {
      // Creator acts as common receiver, member acts as payer
      if (stats[adv.userId]) {
        stats[adv.userId].totalPaid += adv.amount;
        stats[adv.userId].advancesPaid += adv.amount;
      }
      if (stats[trip.creatorId]) {
        stats[trip.creatorId].totalPaid -= adv.amount; // Creator received it, so they are debited
      }
    });

    // 5. Process Petty Cash Transactions
    cashTransactions.forEach(tx => {
      // If funded by a member, credit them
      if (tx.fundedById && stats[tx.fundedById]) {
        stats[tx.fundedById].totalPaid += tx.amountAdded;
        stats[tx.fundedById].pettyCashFunded += tx.amountAdded;
      }
      // If spent on expense, debit the cash holder (cancels out expense payment credit)
      if (tx.expenseId && stats[tx.cashHolderId]) {
        stats[tx.cashHolderId].totalPaid -= tx.amountWithdrawn;
        stats[tx.cashHolderId].pettyCashWithdrawn += tx.amountWithdrawn;
      }
    });

    // 6. Process Completed Settlements (transfer funds between payer and payee)
    completedSettlements.forEach(set => {
      if (stats[set.payerId]) {
        stats[set.payerId].totalPaid += set.amount;
        stats[set.payerId].settlementsSent += set.amount;
      }
      if (stats[set.payeeId]) {
        stats[set.payeeId].totalPaid -= set.amount;
        stats[set.payeeId].settlementsReceived += set.amount;
      }
    });

    // 7. Calculate Final Net Balances
    const finalBalances = [];
    participants.forEach((p, id) => {
      const s = stats[id];
      s.finalBalance = s.totalPaid - s.totalOwed;
      finalBalances.push({
        id: s.id,
        name: s.name,
        totalPaid: s.totalPaid,
        totalOwed: s.totalOwed,
        advancesPaid: s.advancesPaid,
        pettyCashFunded: s.pettyCashFunded,
        pettyCashWithdrawn: s.pettyCashWithdrawn,
        settlementsSent: s.settlementsSent,
        settlementsReceived: s.settlementsReceived,
        finalBalance: s.finalBalance
      });
    });

    // 8. Simplified Settlements (Greedy Algorithm)
    const debtors = [];
    const creditors = [];

    finalBalances.forEach(fb => {
      if (fb.finalBalance < -0.01) {
        debtors.push({ id: fb.id, name: fb.name, balance: Math.abs(fb.finalBalance) });
      } else if (fb.finalBalance > 0.01) {
        creditors.push({ id: fb.id, name: fb.name, balance: fb.finalBalance });
      }
    });

    const suggestedPayments = [];
    let dIdx = 0;
    let cIdx = 0;

    // Greedy matching
    while (dIdx < debtors.length && cIdx < creditors.length) {
      const debtor = debtors[dIdx];
      const creditor = creditors[cIdx];

      const payAmt = Math.min(debtor.balance, creditor.balance);
      suggestedPayments.push({
        from: debtor.id,
        fromName: debtor.name,
        to: creditor.id,
        toName: creditor.name,
        amount: payAmt
      });

      debtor.balance -= payAmt;
      creditor.balance -= payAmt;

      if (debtor.balance < 0.01) dIdx++;
      if (creditor.balance < 0.01) cIdx++;
    }

    // 9. Advance Payment Balance Sheets (utilized vs remaining)
    // For each user, they contributed advances.
    // Utilized advance = min(advancesPaid, totalOwed)
    // Refund due = max(0, advancesPaid - totalOwed) (if their advances + other payments exceed totalOwed)
    const advanceBreakdown = finalBalances.map(fb => {
      const utilized = Math.min(fb.advancesPaid, fb.totalOwed);
      const remaining = fb.advancesPaid - utilized;
      return {
        id: fb.id,
        name: fb.name,
        totalAdvance: fb.advancesPaid,
        utilizedAdvance: utilized,
        remainingAdvance: remaining,
        refundDue: fb.finalBalance > 0 ? Math.min(fb.finalBalance, fb.advancesPaid) : 0
      };
    });

    // 10. Dashboard/General summaries
    const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
    const totalAdvances = approvedAdvances.reduce((sum, adv) => sum + adv.amount, 0);
    
    // Petty Cash in hand
    const totalCashAdded = cashTransactions.reduce((sum, t) => sum + t.amountAdded, 0);
    const totalCashWithdrawn = cashTransactions.reduce((sum, t) => sum + t.amountWithdrawn, 0);
    const cashInHand = totalCashAdded - totalCashWithdrawn;

    res.json({
      totalTripCost: totalExpenses,
      totalAdvances,
      cashInHand,
      balances: finalBalances,
      suggestedPayments,
      advanceBreakdown
    });
  } catch (error) {
    console.error('Error while calculating balances:', error);
    res.status(500).json({ message: 'Server error while calculating balances.' });
  }
});

// POST: Settle Up (Inserts database settlement record)
router.post('/trip/:tripId/settle', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  const { payerId, amount } = req.body;
  const payeeId = req.user.id; // Logged-in user who receives the settlement cash!

  try {
    const trip = req.trip;

    // Check if trip is closed
    if (trip.status === 'CLOSED') {
      return res.status(400).json({ message: 'Cannot record settlements in a closed trip.' });
    }

    const setAmt = parseFloat(amount);
    if (isNaN(setAmt) || setAmt <= 0) {
      return res.status(400).json({ message: 'Settlement amount must be positive.' });
    }

    // Insert Settlement record
    const settlementObj = await prisma.settlement.create({
      data: {
        tripId,
        payerId,
        payeeId,
        amount: setAmt,
        status: 'COMPLETED' // Mark completed instantly
      },
      include: {
        payer: { select: { name: true } },
        payee: { select: { name: true } }
      }
    });

    // Notify payer
    await prisma.notification.create({
      data: {
        userId: payerId,
        title: 'Settlement Recorded ✅',
        message: `${settlementObj.payee.name} marked a settlement of ₹${setAmt.toFixed(2)} paid by you as completed.`,
        type: 'SUCCESS'
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        action: 'SETTLEMENT_COMPLETED',
        userId: req.user.id,
        details: `Recorded settlement of ${setAmt} paid by user ID ${payerId} to user ID ${payeeId}.`
      }
    });

    res.json({ message: 'Settlement completed and recorded successfully!', settlement: settlementObj });
  } catch (error) {
    console.error('Error recording settlement:', error);
    res.status(500).json({ message: 'Server error during settlement recording.' });
  }
});

module.exports = router;