// GS_Triggers.js
// Automated background tasks and cron jobs

/**
 * Run this function ONCE manually from the Google Apps Script editor 
 * to set up the 1-hour recurring trigger for PO approvals.
 */
function setupCronJobs() {
  const functionName = 'cron_processSignedPOs';
  
  // Clear any existing triggers for this function to avoid duplicates
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create a new trigger that runs every 1 hour
  ScriptApp.newTrigger(functionName)
    .timeBased()
    .everyHours(1)
    .create();
    
  console.log("Cron job set up successfully: " + functionName + " will run every 1 hour.");
}

/**
 * Background script to scan the inbox for signed POs from specific managers.
 * Extracts the PDF, saves it to Drive, and updates the PO database.
 */
function cron_processSignedPOs() {
  const managers = ['felix@starlight-vet.com.my', 'anyachiu@petuniverse.com'];
  
  // Build Gmail Search Query
  // Look for unread emails with PDF attachments from the managers
  const fromQuery = managers.map(m => `from:${m}`).join(' OR ');
  const searchQuery = `has:attachment filename:pdf is:unread (${fromQuery})`;
  
  const threads = GmailApp.search(searchQuery);
  
  if (threads.length === 0) {
    console.log("No new signed PO emails found.");
    return;
  }

  const ss = getSpreadsheet();
  const poSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  const poData = poSheet.getDataRange().getValues();
  const headers = poData[0];
  const idxId = headers.indexOf('PO ID');
  const idxSignedUrl = headers.indexOf('Signed URL');
  const idxStatus = headers.indexOf('Status');
  
  if (idxId === -1 || idxSignedUrl === -1 || idxStatus === -1) {
    console.error("Critical columns missing in PurchaseOrder sheet.");
    return;
  }

  // Find the Drive folder for POs
  let folder;
  try {
    folder = DriveApp.getFolderById(PO_CONFIG.FOLDER_ID);
  } catch (e) {
    console.error("Could not find PO Drive folder. Ensure PO_CONFIG.FOLDER_ID is correct.");
    return;
  }

  // Regex to match PO - MMYYYY - XXX (allowing flexible whitespace and underscore separators)
  const poRegex = /PO[\s_]*-?\s*(\d{2})(\d{4})[\s_]*-?\s*(\d{3})/i;
  
  let poSheetModified = false;

  for (const thread of threads) {
    const messages = thread.getMessages();
    
    for (const msg of messages) {
      if (!msg.isUnread()) continue;
      
      const sender = msg.getFrom();
      // Ensure the specific sender is one of our managers (Gmail search can sometimes be broad)
      if (!managers.some(m => sender.toLowerCase().includes(m.toLowerCase()))) {
         continue;
      }
      
      const attachments = msg.getAttachments();
      
      for (const attachment of attachments) {
        if (attachment.getContentType() !== 'application/pdf') continue;
        
        const fileName = attachment.getName();
        const subject = msg.getSubject();
        const body = msg.getPlainBody();
        
        // 1. Search for PO ID in filename, then subject, then body
        let poMatch = fileName.match(poRegex);
        if (!poMatch) poMatch = subject.match(poRegex);
        if (!poMatch) poMatch = body.match(poRegex);
        
        if (poMatch) {
          // Standardize the PO ID format to exactly "PO - MMYYYY - XXX"
          const mm = poMatch[1];
          const yyyy = poMatch[2];
          const seq = poMatch[3];
          const cleanPoId = `PO - ${mm}${yyyy} - ${seq}`;
          
          console.log(`Found PO: ${cleanPoId} from ${sender}`);
          
          // 2. Find row in Database
          let rowIndex = -1;
          for (let i = 1; i < poData.length; i++) {
            if (String(poData[i][idxId]).trim().toUpperCase() === cleanPoId.toUpperCase()) {
              rowIndex = i;
              break;
            }
          }
          
          if (rowIndex !== -1) {
            // 3. Trash old unsigned PDF if it exists (match by PO ID in folder)
            const cleanPoIdUpper = cleanPoId.toUpperCase();
            const existingFiles = folder.getFiles();
            while (existingFiles.hasNext()) {
              const existingFile = existingFiles.next();
              const existingName = existingFile.getName().toUpperCase();
              // Match files containing this PO ID (handles both formats)
              if (existingName.includes(cleanPoIdUpper.replace(/\s+/g, '')) || 
                  existingName.includes(cleanPoIdUpper.replace(/\s+/g, '_'))) {
                try {
                  existingFile.setTrashed(true);
                  console.log(`Trashed old file: ${existingFile.getName()}`);
                } catch (e) {
                  console.warn(`Could not trash old file: ${e.message}`);
                }
              }
            }

            // 4. Save to Drive with normalized name matching apiGeneratePoPdf() convention
            const newFileName = `${cleanPoId}.pdf`;
            const fileBlob = attachment.copyBlob().setName(newFileName);
            const savedFile = folder.createFile(fileBlob);
            
            // Set sharing to match other PO PDFs
            try {
              savedFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            } catch (shareError) {
              console.warn(`Could not set sharing on signed PO: ${shareError.message}`);
            }
            
            const fileUrl = savedFile.getUrl();
            
            // 5. Update memory array
            poData[rowIndex][idxSignedUrl] = fileUrl;
            poData[rowIndex][idxStatus] = 'Approved';
            poSheetModified = true;
            
            console.log(`[AUTO_APPROVAL] ${cleanPoId}: Auto-processed signed PO from ${sender}`);
          } else {
             console.log(`[AUTO_APPROVAL_WARN] ${cleanPoId}: PO found in email from ${sender} but not found in Database.`);
          }
        } else {
            console.log(`PDF found from ${sender} but no PO ID detected in email.`);
        }
      }
      
      // Mark message as read so we don't process it again
      msg.markRead();
    }
  }

  // 6. Batch write to Google Sheets if any POs were updated
  if (poSheetModified) {
    poSheet.getRange(1, 1, poData.length, poData[0].length).setValues(poData);
    // Invalidate cache so UI reflects changes immediately
    CacheService.getScriptCache().remove('PO_HISTORY');
    CacheService.getScriptCache().remove('DASH_STATS');
  }
}
