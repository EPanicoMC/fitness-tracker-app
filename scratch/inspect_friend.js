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
    
    // Fetch today's log for friend
    const friendLog = await getDocument(token, "users/ilaria.musella92@gmail.com/daily_logs/2026-05-24");
    console.log("Friend Log Fields:", Object.keys(friendLog?.fields || {}));
    if (friendLog) {
      console.log("meals_state:", JSON.stringify(friendLog.fields.meals_state, null, 2));
      console.log("extra_meals:", JSON.stringify(friendLog.fields.extra_meals, null, 2));
    }

  } catch (e) {
    console.error(e);
  }
}

run();
