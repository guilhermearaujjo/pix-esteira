const { admin, getDb } = require("./firebase");

function publicReceipt(data) {
  return {
    id: data.id,
    providerPaymentId: data.providerPaymentId,
    payerName: data.payerName,
    amountCents: Number(data.amountCents || 0),
    approvedAt: data.approvedAt,
    source: data.source || "Mercado Pago"
  };
}

async function saveReceipt(receipt) {
  const db = getDb();
  const ref = db.collection("pix_receipts").doc(receipt.id);
  let created = false;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) return;

    created = true;
    transaction.create(ref, {
      ...receipt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return created;
}

async function listReceipts({ fromMs, toMs, limit = 300 }) {
  const db = getDb();
  const snapshot = await db
    .collection("pix_receipts")
    .where("approvedAtMs", ">=", fromMs)
    .where("approvedAtMs", "<=", toMs)
    .orderBy("approvedAtMs", "desc")
    .limit(Math.min(Math.max(limit, 1), 1000))
    .get();

  const all = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data()
  }));

  return {
    receipts: all.slice(0, 300).map(publicReceipt),
    summary: {
      count: all.length,
      totalCents: all.reduce(
        (total, receipt) => total + Number(receipt.amountCents || 0),
        0
      ),
      lastReceivedAt: all[0] ? all[0].approvedAt : null
    }
  };
}

async function markSync(details = {}) {
  const db = getDb();
  const now = new Date();
  await db.collection("pix_system").doc("sync").set(
    {
      ...details,
      lastSyncAt: now.toISOString(),
      lastSyncAtMs: now.getTime(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function getLastSync() {
  const snapshot = await getDb().collection("pix_system").doc("sync").get();
  return snapshot.exists ? snapshot.data().lastSyncAt || null : null;
}

module.exports = {
  getLastSync,
  listReceipts,
  markSync,
  saveReceipt
};
