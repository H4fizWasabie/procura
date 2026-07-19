/**
 * @fileoverview TASK REMINDER MODULE
 * Simple task/reminder management with file attachments and PDF export.
 * Supports CRUD, file uploads to Drive, and shareable PDF generation.
 */

const TASK_CONFIG = {
  // Use spreadsheet parent folder for task attachments (no dedicated folder needed)
  get FOLDER_PREFIX() { return 'TaskAttachments_'; }
};

// --- GET ALL TASKS ---
function apiGetTasks() {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_TASKS);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const h = getHeaderMap(headers);
  const currentUser = Session.getActiveUser().getEmail();
  const userRole = getUserRole(currentUser);
  const result = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const createdBy = String(row[h['created by']] || '').trim();

    // Non-admins only see their own tasks
    if (userRole !== 'ADMIN' && createdBy.toLowerCase() !== currentUser.toLowerCase()) continue;

    let attachments = [];
    try { attachments = JSON.parse(row[h['attachments']] || '[]'); } catch (e) { }

    result.push({
      id: String(row[h['task id']] || ''),
      title: String(row[h['title']] || ''),
      notes: String(row[h['notes']] || ''),
      attachments: attachments,
      status: String(row[h['status']] || 'Pending'),
      createdBy: createdBy,
      createdDate: (row[h['created date']] instanceof Date)
        ? row[h['created date']].toISOString().split('T')[0]
        : String(row[h['created date']] || '')
    });
  }

  // Pending first, then done
  result.sort((a, b) => {
    if (a.status === 'Done' && b.status !== 'Done') return 1;
    if (a.status !== 'Done' && b.status === 'Done') return -1;
    return 0;
  });

  return result;
}

// --- SAVE TASK (Create or Update) ---
function apiSaveTask(taskData) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_TASKS);
    if (!sheet) throw new Error("Tasks sheet not found. Run initDatabaseSchema() first.");

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const h = getHeaderMap(headers);
    const currentUser = Session.getActiveUser().getEmail();

    let taskId = taskData.id;
    let rowIndex = -1;

    // Check if updating existing task
    if (taskId) {
      const idCol = sheet.getRange(2, h['task id'] + 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().flat();
      const idx = idCol.indexOf(taskId);
      if (idx > -1) rowIndex = idx + 2;
    }

    // Generate new ID if creating
    if (rowIndex === -1) {
      taskId = generateNextTaskId(sheet, h);
    }

    const rowData = [];
    headers.forEach((header) => {
      const key = header.toLowerCase().trim();
      switch (key) {
        case 'task id': rowData.push(taskId); break;
        case 'title': rowData.push(sanitizeText(taskData.title || '')); break;
        case 'notes': rowData.push(sanitizeText(taskData.notes || '')); break;
        case 'attachments':
          // Preserve existing attachments if not provided
          if (taskData.attachments !== undefined) {
            rowData.push(JSON.stringify(taskData.attachments));
          } else if (rowIndex > -1) {
            rowData.push(sheet.getRange(rowIndex, h['attachments'] + 1).getValue());
          } else {
            rowData.push('[]');
          }
          break;
        case 'status':
          if (rowIndex > -1) {
            rowData.push(sheet.getRange(rowIndex, h['status'] + 1).getValue());
          } else {
            rowData.push('Pending');
          }
          break;
        case 'created by':
          if (rowIndex > -1) {
            rowData.push(sheet.getRange(rowIndex, h['created by'] + 1).getValue());
          } else {
            rowData.push(currentUser);
          }
          break;
        case 'created date':
          if (rowIndex > -1) {
            rowData.push(sheet.getRange(rowIndex, h['created date'] + 1).getValue());
          } else {
            rowData.push(new Date());
          }
          break;
        default: rowData.push('');
      }
    });

    if (rowIndex > -1) {
      sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
    }

    return { success: true, taskId: taskId, message: rowIndex > -1 ? "Task updated." : "Task created." };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- TOGGLE TASK STATUS ---
function apiToggleTaskStatus(taskId) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_TASKS);
    if (!sheet) throw new Error("Tasks sheet not found.");

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const h = getHeaderMap(headers);
    const idCol = sheet.getRange(2, h['task id'] + 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().flat();
    const idx = idCol.indexOf(taskId);

    if (idx === -1) throw new Error("Task not found.");

    const rowIdx = idx + 2;
    const currentStatus = sheet.getRange(rowIdx, h['status'] + 1).getValue();
    const newStatus = currentStatus === 'Done' ? 'Pending' : 'Done';

    sheet.getRange(rowIdx, h['status'] + 1).setValue(newStatus);

    return { success: true, status: newStatus };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- DELETE TASK ---
function apiDeleteTask(taskId) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_TASKS);
    if (!sheet) throw new Error("Tasks sheet not found.");

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const h = getHeaderMap(headers);
    const idCol = sheet.getRange(2, h['task id'] + 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().flat();
    const idx = idCol.indexOf(taskId);

    if (idx === -1) throw new Error("Task not found.");

    // Delete associated Drive files
    const rowIdx = idx + 2;
    const attachStr = sheet.getRange(rowIdx, h['attachments'] + 1).getValue();
    try {
      const attachments = JSON.parse(attachStr || '[]');
      attachments.forEach(att => {
        try { DriveApp.getFileById(att.id).setTrashed(true); } catch (e) { }
      });
    } catch (e) { }

    sheet.deleteRow(rowIdx);

    return { success: true, message: "Task deleted." };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- UPLOAD ATTACHMENT ---
function apiUploadTaskAttachment(taskId, base64Data, mimeType, fileName) {
  assertPermission(['EDITOR', 'ADMIN']);
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_TASKS);
    if (!sheet) throw new Error("Tasks sheet not found.");

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const h = getHeaderMap(headers);
    const idCol = sheet.getRange(2, h['task id'] + 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().flat();
    const idx = idCol.indexOf(taskId);

    if (idx === -1) throw new Error("Task not found.");

    const rowIdx = idx + 2;

    // Get or create task attachments folder
    let folder = getOrCreateTaskFolder(ss);

    // Remove existing file with same name in this task
    const existing = folder.getFilesByName(fileName);
    while (existing.hasNext()) {
      try { existing.next().setTrashed(true); } catch (e) { }
    }

    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
    const file = folder.createFile(blob);

    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
      console.warn("Could not set sharing: " + e.message);
    }

    // Update attachments JSON
    let attachments = [];
    try { attachments = JSON.parse(sheet.getRange(rowIdx, h['attachments'] + 1).getValue() || '[]'); } catch (e) { }

    attachments.push({
      name: fileName,
      url: file.getUrl(),
      id: file.getId(),
      type: mimeType
    });

    sheet.getRange(rowIdx, h['attachments'] + 1).setValue(JSON.stringify(attachments));

    return { success: true, url: file.getUrl(), attachments: attachments };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// --- EXPORT TASK AS PDF ---
function apiExportTaskPdf(taskId) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_TASKS);
    if (!sheet) throw new Error("Tasks sheet not found.");

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const h = getHeaderMap(headers);
    const idCol = sheet.getRange(2, h['task id'] + 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().flat();
    const idx = idCol.indexOf(taskId);

    if (idx === -1) throw new Error("Task not found.");

    const row = data[idx + 1];
    let attachments = [];
    try { attachments = JSON.parse(row[h['attachments']] || '[]'); } catch (e) { }

    const taskInfo = {
      id: String(row[h['task id']] || ''),
      title: String(row[h['title']] || ''),
      notes: String(row[h['notes']] || ''),
      status: String(row[h['status']] || 'Pending'),
      createdBy: String(row[h['created by']] || ''),
      createdDate: (row[h['created date']] instanceof Date)
        ? row[h['created date']].toLocaleDateString()
        : String(row[h['created date']] || '')
    };

    // Generate HTML for PDF
    const attachmentRows = attachments.map(att =>
      `<tr><td style="padding:6px 12px; border-bottom:1px solid #eee;">${att.name}</td>
       <td style="padding:6px 12px; border-bottom:1px solid #eee;"><a href="${att.url}">${att.url}</a></td></tr>`
    ).join('');

    const html = `
    <div style="font-family:Arial,sans-serif; max-width:700px; margin:auto; padding:30px;">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid #6366f1; padding-bottom:15px; margin-bottom:20px;">
        <div>
          <h1 style="margin:0; color:#1e293b; font-size:22px;">📋 Task Reminder</h1>
          <p style="margin:4px 0 0; color:#64748b; font-size:13px;">STARLiGHT Veterinary Medical Center</p>
        </div>
        <div style="text-align:right;">
          <span style="background:${taskInfo.status === 'Done' ? '#10b981' : '#f59e0b'}; color:white; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:bold;">
            ${taskInfo.status === 'Done' ? '✅ DONE' : '⏳ PENDING'}
          </span>
        </div>
      </div>
      
      <table style="width:100%; margin-bottom:20px;">
        <tr><td style="color:#64748b; font-size:12px; padding:4px 0;">Task ID</td><td style="font-weight:bold; padding:4px 0;">${taskInfo.id}</td></tr>
        <tr><td style="color:#64748b; font-size:12px; padding:4px 0;">Title</td><td style="font-weight:bold; font-size:16px; padding:4px 0;">${taskInfo.title}</td></tr>
        <tr><td style="color:#64748b; font-size:12px; padding:4px 0;">Created By</td><td style="padding:4px 0;">${taskInfo.createdBy}</td></tr>
        <tr><td style="color:#64748b; font-size:12px; padding:4px 0;">Created Date</td><td style="padding:4px 0;">${taskInfo.createdDate}</td></tr>
      </table>

      <div style="margin-bottom:20px;">
        <h3 style="color:#1e293b; margin-bottom:8px;">Notes</h3>
        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:15px; white-space:pre-wrap; font-size:14px; line-height:1.6;">
          ${taskInfo.notes || '<span style="color:#94a3b8;">No notes added.</span>'}
        </div>
      </div>

      ${attachments.length > 0 ? `
      <div>
        <h3 style="color:#1e293b; margin-bottom:8px;">Attachments (${attachments.length})</h3>
        <table style="width:100%; border-collapse:collapse; border:1px solid #e2e8f0; border-radius:8px;">
          <tr style="background:#f1f5f9;"><th style="padding:8px 12px; text-align:left; font-size:12px; color:#64748b;">File Name</th><th style="padding:8px 12px; text-align:left; font-size:12px; color:#64748b;">Link</th></tr>
          ${attachmentRows}
        </table>
      </div>
      ` : ''}

      <div style="margin-top:30px; padding-top:15px; border-top:1px solid #e2e8f0; font-size:11px; color:#94a3b8; text-align:center;">
        Generated by ProcurePilot | ${new Date().toLocaleString()}
      </div>
    </div>`;

    const blob = Utilities.newBlob(html, MimeType.HTML, `${taskId}.html`).getAs(MimeType.PDF).setName(`${taskId}.pdf`);

    // Save to Drive
    let folder = getOrCreateTaskFolder(ss);
    const existingFiles = folder.getFilesByName(`${taskId}.pdf`);
    while (existingFiles.hasNext()) existingFiles.next().setTrashed(true);

    const file = folder.createFile(blob);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) { }

    return {
      success: true,
      url: file.getUrl(),
      base64: Utilities.base64Encode(blob.getBytes()),
      fileName: `${taskId}.pdf`
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// --- HELPERS ---
function generateNextTaskId(sheet, h) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 'TK-001';

  const ids = sheet.getRange(2, h['task id'] + 1, lastRow - 1, 1).getValues().flat();
  let maxNum = 0;
  ids.forEach(id => {
    const match = String(id || '').match(/TK-(\d+)/);
    if (match) { const n = parseInt(match[1], 10); if (n > maxNum) maxNum = n; }
  });

  return 'TK-' + String(maxNum + 1).padStart(3, '0');
}

function getOrCreateTaskFolder(ss) {
  const folderName = TASK_CONFIG.FOLDER_PREFIX + ss.getId().substring(0, 8);
  const ssFile = DriveApp.getFileById(ss.getId());
  const parentFolder = ssFile.getParents().next();

  const existing = parentFolder.getFoldersByName(folderName);
  if (existing.hasNext()) return existing.next();

  return parentFolder.createFolder(folderName);
}