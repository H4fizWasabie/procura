/* WORKFLOW & EMAIL ENGINE
   Handles Batch Approvals and Payment Requests.
   Updated: Invoices are now attached to ALL emails if available.
*/

const WORKFLOW_CONFIG = {
  APP_NAME: "ProcurePilot",
  THRESHOLD_VALUE: 2000.00, // Trigger for Tier 2 Approval
  EMAIL_ROUTING: {
    APPROVERS: {
      TIER_1: "felix@starlight-vet.com.my",
      TIER_2: "anyachiu@petuniverse.com"
    },
    FINANCE: ["rahmanpetuniverse@gmail.com"],
    PAYMENT_CC: [],
    CC_GROUPS: {
      PHARMACY: ["anushambigai@starlight-vet.com.my"],
      LAB: ["lab@starlight-vet.com.my", "nuramirah@starlight-vet.com.my"]
    }
  }
};

// --- READ: STAGING AREA CONTEXT ---
function apiGetWorkflowContext() {
  assertPermission(['EDITOR', 'ADMIN']);
  return {
    history: apiGetPOHistory(),
    config: {
      userEmail: Session.getActiveUser().getEmail(),
      threshold: WORKFLOW_CONFIG.THRESHOLD_VALUE
    }
  };
}

// --- PREVIEW BATCH EMAIL & FILES ---
function apiGetBatchEmailPreview(poIds, mode) {
  assertPermission(['EDITOR', 'ADMIN']);

  try {
    const poList = fetchBatchData(poIds);
    if (poList.length === 0) throw new Error("No POs found.");

    let totalValue = 0;
    let maxSingleValue = 0;
    let tableRows = "";

    const ccSet = new Set([
      Session.getActiveUser().getEmail()
    ]);

    // Add Mode-Specific CCs
    if (mode === 'PAYMENT') {
      WORKFLOW_CONFIG.EMAIL_ROUTING.PAYMENT_CC.forEach(email => { if (email) ccSet.add(email); });
    } else {
      // Approval mode doesn't have a default beyond the sender for now, 
      // but we'll add the CC groups based on department below.
    }

    poList.forEach((p, idx) => {
      totalValue += p.total;
      if (p.total > maxSingleValue) maxSingleValue = p.total;

      if (p.dept) {
        const deptKey = String(p.dept).toUpperCase().trim();
        if (deptKey.includes("PHARMACY")) {
          WORKFLOW_CONFIG.EMAIL_ROUTING.CC_GROUPS.PHARMACY.forEach(email => ccSet.add(email));
        }
        if (deptKey.includes("LAB")) {
          WORKFLOW_CONFIG.EMAIL_ROUTING.CC_GROUPS.LAB.forEach(email => ccSet.add(email));
        }
      }

      const bg = idx % 2 === 0 ? '#ffffff' : '#f9fafb';
      tableRows += `
         <tr style="background-color: ${bg}; border-bottom:1px solid #eee;">
           <td style="padding:8px;">${p.id}</td>
           <td style="padding:8px;">${p.supplier}</td>
           <td style="padding:8px; text-align:right;">RM ${p.total.toLocaleString('en-MY', { minimumFractionDigits: 2 })}</td>
         </tr>`;
    });

    // --- ATTACHMENTS LOGIC (UPDATED) ---
    // Now attaches Invoice if it exists, regardless of mode.
    const attachments = [];
    poList.forEach(p => {
      // 1. Signed PO (Always)
      attachments.push({
        id: p.id,
        name: `${p.id}.pdf`,
        url: p.signedUrl || null,
        type: 'PO',
        docType: 'SIGNED'
      });

      // 2. Invoice (Attach if exists OR if mode is Payment)
      // If mode is Payment, we force it to show (so it appears as "Missing" if null)
      // If mode is Approval, we only show it if the file actually exists.
      if (mode === 'PAYMENT' || p.invUrl) {
        attachments.push({
          id: p.id,
          name: `INV_${p.id}.pdf`,
          url: p.invUrl || null,
          type: 'INV',
          docType: 'INVOICE'
        });
      }

      // 3. Item History Report (Attach if exists)
      if (p.itemHistUrl) {
        attachments.push({
          id: p.id,
          name: `ITEM_HISTORY_${p.id}`,
          url: p.itemHistUrl,
          type: 'HIST',
          docType: 'ITEM_HISTORY'
        });
      }
    });

    // Determine Recipients
    let to = "", subject = "", bodyIntro = "", directive = "";

    if (mode === 'PAYMENT') {
      to = WORKFLOW_CONFIG.EMAIL_ROUTING.FINANCE.join(',');
      subject = `[PAYMENT REQUEST] ${poList.length} POs - RM ${totalValue.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;
      bodyIntro = "Dear Finance Team,";
      directive = `<div style="background:#eff6ff; padding:15px; margin-top:20px; border-left:4px solid #2980b9;">
                      <b>FINANCE DIRECTIVE:</b><br>The listed POs are approved and goods/services verified. Please proceed with payment.
                    </div>`;

      if (maxSingleValue > WORKFLOW_CONFIG.THRESHOLD_VALUE) {
        ccSet.add(WORKFLOW_CONFIG.EMAIL_ROUTING.APPROVERS.TIER_2);
      }

    } else { // APPROVAL
      const isHigh = maxSingleValue > WORKFLOW_CONFIG.THRESHOLD_VALUE;
      to = isHigh ? WORKFLOW_CONFIG.EMAIL_ROUTING.APPROVERS.TIER_2 : WORKFLOW_CONFIG.EMAIL_ROUTING.APPROVERS.TIER_1;
      const approverName = isHigh ? "Dr. Anya" : "Dr. Felix";

      subject = `[APPROVAL REQUEST] ${poList.length} POs - RM ${totalValue.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;
      bodyIntro = `Dear ${approverName},`;
      directive = `<div style="background:#f0fdf4; padding:15px; margin-top:20px; border-left:4px solid #27ae60;">
                      <b>ACTION REQUIRED:</b><br>Please review and approve the listed Purchase Orders.
                    </div>`;
    }

    const emailBody = `
      <div style="font-family: 'Segoe UI', sans-serif; color: #333;">
        <h3>${bodyIntro}</h3>
        <p>I am submitting the following batch for ${mode === 'PAYMENT' ? 'payment processing' : 'your approval'}.</p>
        <p><b>Total Value: RM ${totalValue.toLocaleString('en-MY', { minimumFractionDigits: 2 })}</b></p>
        
        <table style="width:100%; border-collapse:collapse; border:1px solid #ddd; font-size:14px;">
          <thead style="background:#2c3e50; color:white;">
            <tr>
              <th style="padding:8px; text-align:left;">PO ID</th>
              <th style="padding:8px; text-align:left;">Supplier</th>
              <th style="padding:8px; text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
        ${directive}
        <br>
        <p style="color:#777; font-size:12px;">Generated by ${WORKFLOW_CONFIG.APP_NAME}</p>
      </div>
    `;

    return {
      success: true,
      data: {
        to: to,
        cc: Array.from(ccSet).join(','),
        subject: subject,
        body: emailBody,
        attachments: attachments
      }
    };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

// --- SEND EMAIL ---
function apiProcessBatchEmail(payload) {
  assertPermission(['EDITOR', 'ADMIN']);

  try {
    const draft = payload.draft;
    const poIds = payload.poIds;
    const mode = payload.mode;

    // 1. Fetch Attachments
    const poList = fetchBatchData(poIds);
    const blobs = [];

    const fetchFile = (url, name) => {
      if (!url) return null;
      try {
        const id = url.match(/[-\w]{25,}/);
        if (id) return DriveApp.getFileById(id[0]).getAs(MimeType.PDF).setName(name);
      } catch (e) { console.log("File Error: " + e.message); }
      return null;
    };

    // Helper to fetch raw file blob (without PDF conversion)
    const fetchRawBlob = (url, name) => {
      if (!url) return null;
      try {
        const id = url.match(/[-\w]{25,}/);
        if (id) return DriveApp.getFileById(id[0]).getBlob().setName(name);
      } catch (e) { console.log("Raw File Error: " + e.message); }
      return null;
    };

    poList.forEach(po => {
      // Signed PO
      const poPdf = fetchFile(po.signedUrl, `${po.id}.pdf`);
      if (poPdf) blobs.push(poPdf);

      // Invoice (Attach if exists OR if in Payment Mode)
      if (po.invUrl) {
        const invPdf = fetchFile(po.invUrl, `Inv_${po.id}.pdf`);
        if (invPdf) blobs.push(invPdf);
      }

      // Item History Report (Excel/CSV - send as-is, no PDF conversion)
      if (po.itemHistUrl) {
        const fileName = po.itemHistUrl.includes('.pdf') 
          ? `Item_History_${po.id}.pdf`
          : `Item_History_${po.id}.csv`;
        const histFile = fetchRawBlob(po.itemHistUrl, fileName);
        if (histFile) blobs.push(histFile);
      }
    });

    // 2. Validate recipients before sending
    const toEmails = String(draft.to || '').trim();
    if (!toEmails) {
      return { success: false, error: "No recipient email address configured." };
    }

    // 3. Send Email
    const procurementEmail = ADMIN_CONFIG.EMAIL_TARGET;

    const options = {
      htmlBody: draft.body,
      cc: draft.cc,
      name: "Starlight Procurement System",
      replyTo: procurementEmail,
      attachments: blobs
    };

    MailApp.sendEmail(toEmails, draft.subject, "", options);

    // 3. Update Status
    poIds.forEach(id => {
      const newStatus = (mode === 'PAYMENT') ? "Pending Payment" : "Pending Approval";
      apiUpdatePOStatus(id, newStatus, 'PMT');
    });

    return { success: true, message: "Batch Email Sent Successfully." };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

// --- HELPER ---
function fetchBatchData(poIds) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const idxId = headers.indexOf('PO ID');
  const idxSup = headers.indexOf('Supplier');
  const idxTot = headers.indexOf('Total');
  const idxDept = headers.indexOf('Dept');
  const idxInv = headers.indexOf('Inv URL');
  const idxSign = headers.indexOf('Signed URL');
  const idxHist = headers.indexOf('Item History URL');

  const list = [];

  poIds.forEach(id => {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idxId]) === String(id)) {
        list.push({
          id: id,
          supplier: data[i][idxSup],
          dept: data[i][idxDept],
          total: parseFloat(data[i][idxTot]) || 0,
          invUrl: data[i][idxInv],
          signedUrl: data[i][idxSign],
          itemHistUrl: data[i][idxHist]
        });
        break;
      }
    }
  });
  return list;
}

// --- UPLOAD DOC HELPER ---
function apiUploadPoDoc(poId, base64, mime, filename, docType) {
  assertPermission(['EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(poId)) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex === -1) return { success: false, error: "PO Not Found" };

  try {
    const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, filename);
    const folder = DriveApp.getFolderById(PO_CONFIG.FOLDER_ID);

    const existing = folder.getFilesByName(filename);
    while (existing.hasNext()) existing.next().setTrashed(true);

    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const fileUrl = file.getUrl();

    const colName = (docType === 'INVOICE') ? 'Inv URL' : 'Signed URL';
    const colIdx = headers.indexOf(colName);

    if (colIdx > -1) sheet.getRange(rowIndex, colIdx + 1).setValue(fileUrl);

    return { success: true, url: fileUrl };

  } catch (e) {
    return { success: false, error: e.message };
  }
}