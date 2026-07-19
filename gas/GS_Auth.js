/**
 * @fileoverview AUTHENTICATION ENGINE
 * Handles Login verification against System_Users
 * UPDATED: Implemented 3-Strike Brute-force protection.
 */

/**
 * Secure SHA-256 Hasher
 */
function hashPin(pin) {
  const signature = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pin));
  let hash = "";
  for (let i = 0; i < signature.length; i++) {
    let byte = signature[i];
    if (byte < 0) byte += 256;
    let byteStr = byte.toString(16);
    if (byteStr.length == 1) byteStr = "0" + byteStr;
    hash += byteStr;
  }
  return hash;
}

function apiLogin(email, password) {
  const props = PropertiesService.getScriptProperties();
  const lockoutKey = "LOCKOUT_" + email.toLowerCase().trim();
  const attemptKey = "ATTEMPTS_" + email.toLowerCase().trim();
  const LOCKOUT_TIERS = [5, 15, 60]; // Exponential backoff: 5m, 15m, 60m

  // 1. Check Lockout Status
  const lockoutTime = props.getProperty(lockoutKey);
  if (lockoutTime && Date.now() < parseInt(lockoutTime)) {
    const remaining = Math.ceil((parseInt(lockoutTime) - Date.now()) / 60000);
    return { success: false, error: `⛔ Account locked due to failed attempts. Try again in ${remaining} minutes.` };
  }

  // 2. Validate Input
  if (!email || !password) {
    return { success: false, error: "Please enter email and password." };
  }

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);

  if (!sheet) return { success: false, error: "System Error: User DB missing." };

  const data = sheet.getDataRange().getValues();
  let userFound = null;
  let rowIndex = -1;

  const inputHash = hashPin(String(password).trim());

  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][0]).trim().toLowerCase();

    if (rowEmail === email.trim().toLowerCase()) {
      const storedPin = String(data[i][5]).trim();

      // Migration logic: Support both plain text and hash
      if (storedPin === inputHash || storedPin === String(password).trim()) {
        userFound = {
          email: rowEmail,
          role: data[i][1],
          name: data[i][2],
          dept: data[i][3],
          mustChangePin: data[i][6] === true || String(data[i][6]).toLowerCase() === 'true'
        };
        rowIndex = i + 1;

        // Auto-migrate to hash on successful login
        if (storedPin !== inputHash) {
          sheet.getRange(rowIndex, 6).setValue(inputHash);
        }
      }
      break;
    }
  }

  if (userFound) {
    // SUCCESS: Clear failures
    props.deleteProperty(attemptKey);
    props.deleteProperty(lockoutKey);

    // Generate server-side session token (8-hour TTL)
    const sessionToken = Utilities.getUuid();
    CacheService.getScriptCache().put(
      'SESSION_' + userFound.email.toLowerCase(),
      sessionToken,
      28800 // 8 hours in seconds
    );

    // Update Last Access Timestamp
    try {
      const timestamp = new Date();
      sheet.getRange(rowIndex, 5).setValue(timestamp);
    } catch (e) { console.error("Failed to update login timestamp", e); }

    return { success: true, user: userFound, sessionToken: sessionToken };
  } else {
    // FAILURE: Increment Strike
    let attempts = parseInt(props.getProperty(attemptKey) || "0") + 1;
    props.setProperty(attemptKey, attempts.toString());

    if (attempts >= 3) {
      const tier = Math.min(attempts - 3, LOCKOUT_TIERS.length - 1);
      const lockoutMinutes = LOCKOUT_TIERS[Math.max(0, tier)];
      const expiry = Date.now() + (lockoutMinutes * 60 * 1000);
      props.setProperty(lockoutKey, expiry.toString());
      logSystemAction('SECURITY_ALERT', 'AUTH', email, `${attempts} Failed Attempts - Locked ${lockoutMinutes}m`);
      return { success: false, error: `⛔ Too many failed attempts. Account locked for ${lockoutMinutes} minutes.` };
    }

    return { success: false, error: `Invalid credentials. strike ${attempts}/3.` };
  }
}

/**
 * Register a new user and send temporary PIN via email.
 */
function apiRegisterUser(data) {
  if (!data.email || !data.name || !data.dept) {
    return { success: false, error: "Missing required fields." };
  }

  // Domain Validation (Optional - strict for internal use)
  // if (!data.email.endsWith("@starlight-vet.com.my")) return { success: false, error: "Invalid Email Domain." };

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);
  const users = sheet.getDataRange().getValues();

  // Check Exists
  for (let i = 1; i < users.length; i++) {
    if (String(users[i][0]).toLowerCase() === data.email.toLowerCase()) {
      return { success: false, error: "Email already registered. Use 'Forgot PIN' instead." };
    }
  }

  // Generate Temp PIN
  const tempPin = String(Math.floor(100000 + Math.random() * 900000));
  const pinHash = hashPin(tempPin);

  // Add User (Role=VIEWER, MustChangePin=TRUE)
  sheet.appendRow([
    data.email,
    "VIEWER",
    data.name,
    data.dept,
    new Date(),
    pinHash,
    true // Must Change PIN
  ]);

  // Send Email
  try {
    MailApp.sendEmail({
      to: data.email,
      subject: "Welcome to ProcurePilot - Your Temporary Access PIN",
      htmlBody: `
        <h3>Welcome to ProcurePilot</h3>
        <p>Hi ${data.name},</p>
        <p>Your account has been created. Please use the following PIN to log in for the first time:</p>
        <div style="font-size:24px; font-weight:bold; color:#4f46e5; margin:15px 0;">${tempPin}</div>
        <p>You will be required to change this PIN immediately upon logging in.</p>
      `
    });
    return { success: true, message: "Registration successful. Please check your email for the temporary PIN." };
  } catch (e) {
    return { success: false, error: "User created but failed to send email. Contact Admin." };
  }
}

/**
 * Force Change PIN (First Login)
 */
function apiChangePin(email, oldPin, newPin) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;

  if (newPin.length < 6) return { success: false, error: "New PIN must be at least 6 digits." };

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === email.toLowerCase()) {
      const storedPin = String(data[i][5]);
      const oldHash = hashPin(String(oldPin));

      // Verify Old PIN
      if (storedPin !== oldHash && storedPin !== String(oldPin)) {
        return { success: false, error: "Incorrect current PIN." };
      }

      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex === -1) return { success: false, error: "User not found." };

  // Update PIN and Clear Flag
  sheet.getRange(rowIndex, 6).setValue(hashPin(String(newPin))); // Update Hash
  sheet.getRange(rowIndex, 7).setValue(false); // Clear MustChangePin flag

  return { success: true, message: "PIN Updated Successfully." };
}

/**
 * apiResetPin — Generates a new random PIN and emails it to the user.
 * Called from the "Forgot PIN" panel on the login screen.
 */
function apiResetPin(email) {
  if (!email || !email.includes('@')) {
    return { success: false, error: 'Please enter a valid email address.' };
  }

  // Rate-limit: 1 reset per email per 15 minutes
  const cache = CacheService.getScriptCache();
  const rateLimitKey = 'RESET_RL_' + email.toLowerCase().trim();
  if (cache.get(rateLimitKey)) {
    return { success: true }; // Silent success to prevent enumeration
  }
  cache.put(rateLimitKey, '1', 900); // 15 minutes

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);
  if (!sheet) return { success: false, error: 'System Error: User DB missing.' };

  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  let userName = '';

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email.trim().toLowerCase()) {
      rowIndex = i + 1;
      userName = data[i][2] || 'User';
      break;
    }
  }

  // Always return success to avoid email enumeration attacks
  if (rowIndex === -1) {
    return { success: true };
  }

  // Generate a new 6-digit PIN
  const newPin = String(Math.floor(100000 + Math.random() * 900000));
  const newHash = hashPin(newPin);

  // Update the sheet AND set MustChangePin = TRUE
  sheet.getRange(rowIndex, 6).setValue(newHash);
  sheet.getRange(rowIndex, 7).setValue(true); // Force change on next login

  // Send the email
  try {
    MailApp.sendEmail(
      email.trim(),
      '🔐 ProcurePilot — Your New Security PIN',
      '',
      {
        htmlBody: `
          <div style="font-family:'Inter',sans-serif; max-width:480px; margin:0 auto; background:#f8fafc; border-radius:16px; overflow:hidden; border:1px solid #e2e8f0;">
            <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed); padding:32px; text-align:center;">
              <h2 style="color:#fff; margin:0; font-size:1.4rem; font-weight:800;">ProcurePilot</h2>
              <p style="color:rgba(255,255,255,0.8); margin:6px 0 0; font-size:0.85rem;">STARLiGHT Veterinary Medical Center</p>
            </div>
            <div style="padding:32px;">
              <p style="color:#1e293b; font-size:1rem;">Hi <strong>${userName}</strong>,</p>
              <p style="color:#475569; font-size:0.95rem; line-height:1.6;">
                A PIN reset was requested for your account. Your new Security PIN is:
              </p>
              <div style="background:#f1f5f9; border:2px dashed #6366f1; border-radius:12px; padding:20px; text-align:center; margin:24px 0;">
                <span style="font-size:2.5rem; font-weight:900; letter-spacing:0.3em; color:#4f46e5;">${newPin}</span>
              </div>
              <p style="color:#94a3b8; font-size:0.82rem; line-height:1.5;">
                Please log in and change your PIN immediately. If you did not request this reset, contact your system administrator.
              </p>
            </div>
            <div style="background:#f1f5f9; padding:16px; text-align:center; border-top:1px solid #e2e8f0;">
              <p style="color:#94a3b8; font-size:0.78rem; margin:0;">© ${new Date().getFullYear()} STARLiGHT Veterinary Medical Center · ProcurePilot</p>
            </div>
          </div>
        `
      }
    );
  } catch (e) {
    return { success: false, error: 'Failed to send email. Please contact your administrator.' };
  }

  return { success: true };
}