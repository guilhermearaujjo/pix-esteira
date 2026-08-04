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

    if (snapshot.exists) {
      return;
    }

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
        (total, receipt) =>
          total + Number(receipt.amountCents || 0),
        0
      ),
      lastReceivedAt: all[0]
        ? all[0].approvedAt
        : null
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
  const snapshot = await getDb()
    .collection("pix_system")
    .doc("sync")
    .get();

  return snapshot.exists
    ? snapshot.data().lastSyncAt || null
    : null;
}

async function saveReportJob(report, period) {
  const id = String(
    report && report.id ? report.id : ""
  ).trim();

  if (!id) {
    throw new Error(
      "Mercado Pago não devolveu o ID do relatório."
    );
  }

  const now = new Date();
  const db = getDb();
  const batch = db.batch();

  const jobRef = db
    .collection("pix_report_jobs")
    .doc(id);

  const stateRef = db
    .collection("pix_system")
    .doc("account_report");

  batch.set(
    jobRef,
    {
      id,
      status: "pending",
      fileName: report.file_name || null,
      providerStatus: report.status || "pending",
      beginDate: period.beginDate,
      endDate: period.endDate,
      requestedAt: now.toISOString(),
      requestedAtMs: now.getTime(),
      createdAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  batch.set(
    stateRef,
    {
      lastJobId: id,
      lastRequestedAt: now.toISOString(),
      lastRequestedAtMs: now.getTime(),
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await batch.commit();

  return id;
}

async function getReportState() {
  const snapshot = await getDb()
    .collection("pix_system")
    .doc("account_report")
    .get();

  return snapshot.exists ? snapshot.data() : {};
}

function reportFileDocumentId(report) {
  const supplied = String(
    (report && (report.id || report.file_name)) || ""
  ).trim();

  if (!supplied) {
    throw new Error(
      "Relatório sem ID e sem nome de arquivo."
    );
  }

  return supplied.replace(/[/.]/g, "_");
}

async function reportFileAlreadyImported(report) {
  const snapshot = await getDb()
    .collection("pix_report_files")
    .doc(reportFileDocumentId(report))
    .get();

  return (
    snapshot.exists &&
    snapshot.data().status === "imported"
  );
}

async function markReportFileImported(
  report,
  details = {}
) {
  await getDb()
    .collection("pix_report_files")
    .doc(reportFileDocumentId(report))
    .set(
      {
        reportId: report.id
          ? String(report.id)
          : null,
        fileName: report.file_name || null,
        providerStatus:
          report.status || "processed",
        beginDate: report.begin_date || null,
        endDate: report.end_date || null,
        ...details,
        status: "imported",
        importedAt: new Date().toISOString(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
}

async function markReportRequestBlocked(
  details = {}
) {
  await getDb()
    .collection("pix_system")
    .doc("account_report")
    .set(
      {
        ...details,
        quotaLimitedAt: new Date().toISOString(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
}

async function markReportConfigured(details = {}) {
  await getDb()
    .collection("pix_system")
    .doc("account_report")
    .set(
      {
        ...details,
        configuredAt: new Date().toISOString(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
}

async function listPendingReportJobs(limit = 20) {
  const safeLimit = Math.min(
    Math.max(limit, 1),
    50
  );

  const collection = getDb()
    .collection("pix_report_jobs");

  const [pendingSnapshot, expiredSnapshot] =
    await Promise.all([
      collection
        .where("status", "==", "pending")
        .limit(safeLimit)
        .get(),
      collection
        .where("status", "==", "expired")
        .limit(safeLimit)
        .get()
    ]);

  const jobsById = new Map();

  for (
    const snapshot of [
      pendingSnapshot,
      expiredSnapshot
    ]
  ) {
    for (const doc of snapshot.docs) {
      jobsById.set(doc.id, {
        id: doc.id,
        ...doc.data()
      });
    }
  }

  return [...jobsById.values()]
    .sort(
      (a, b) =>
        Number(a.requestedAtMs || 0) -
        Number(b.requestedAtMs || 0)
    )
    .slice(0, safeLimit);
}

async function reopenReportJob(
  jobId,
  details = {}
) {
  await getDb()
    .collection("pix_report_jobs")
    .doc(String(jobId))
    .set(
      {
        ...details,
        status: "pending",
        recoveredAt: new Date().toISOString(),
        finishedAt:
          admin.firestore.FieldValue.delete(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
}

async function markReportChecked(
  jobId,
  details = {}
) {
  await getDb()
    .collection("pix_report_jobs")
    .doc(String(jobId))
    .set(
      {
        ...details,
        lastCheckedAt: new Date().toISOString(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
}

async function finishReportJob(
  jobId,
  details = {}
) {
  await getDb()
    .collection("pix_report_jobs")
    .doc(String(jobId))
    .set(
      {
        ...details,
        status: details.status || "processed",
        finishedAt: new Date().toISOString(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
}

module.exports = {
  finishReportJob,
  getLastSync,
  getReportState,
  listReceipts,
  listPendingReportJobs,
  markReportChecked,
  markReportConfigured,
  markReportFileImported,
  markReportRequestBlocked,
  markSync,
  reopenReportJob,
  reportFileAlreadyImported,
  saveReceipt,
  saveReportJob
};
