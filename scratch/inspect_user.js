const projectId = "fitness-tracker-app-b6792";
const apiKey = "AIzaSyC7bm-wJAScIaQfelZkGP4C7kw_FKI4Gv8";

async function signIn(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  if (!res.ok) {
    throw new Error(`Sign in failed: ${await res.text()}`);
  }
  return await res.json();
}

async function getDocument(token, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Get document failed: ${await res.text()}`);
  }
  return await res.json();
}

async function run() {
  try {
    const authData = await signIn("enricopanico@gmail.com", "password123");
    const token = authData.idToken;
    console.log("Sign in successful!");
    
    // Fetch settings
    const settings = await getDocument(token, "users/enricopanico@gmail.com/settings/app");
    const friendEmailField = settings?.fields?.friend_email?.stringValue;
    console.log("Friend email in DB settings:", friendEmailField);

    if (friendEmailField) {
      // Fetch today's log for friend (try direct)
      const friendLog = await getDocument(token, `users/${friendEmailField}/daily_logs/2026-05-24`);
      console.log(`Friend (${friendEmailField}) log exists?`, friendLog ? "YES" : "NO");
      
      const friendLogLower = await getDocument(token, `users/${friendEmailField.toLowerCase()}/daily_logs/2026-05-24`);
      console.log(`Friend (${friendEmailField.toLowerCase()}) log exists?`, friendLogLower ? "YES" : "NO");
      
      // Let's also check if user document for friend exists under case-sensitive and lower
      const friendUser = await getDocument(token, `users/${friendEmailField}`);
      console.log(`Friend (${friendEmailField}) user doc exists?`, friendUser ? "YES" : "NO");

      const friendUserLower = await getDocument(token, `users/${friendEmailField.toLowerCase()}`);
      console.log(`Friend (${friendEmailField.toLowerCase()}) user doc exists?`, friendUserLower ? "YES" : "NO");
    }

  } catch (e) {
    console.error(e);
  }
}

run();
