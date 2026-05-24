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

async function getCollection(token, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Get collection failed: ${await res.text()}`);
  }
  return await res.json();
}

async function run() {
  try {
    const authData = await signIn("enricopanico@gmail.com", "password123");
    const token = authData.idToken;
    console.log("Sign in successful!");
    
    // Fetch friend's diet plans
    const diets = await getCollection(token, "users/ilaria.musella92@gmail.com/diet_plans");
    console.log("Friend Diet Plans Documents Count:", diets.documents?.length || 0);
    if (diets.documents) {
      diets.documents.forEach(d => {
        const name = d.name.split("/").pop();
        const active = d.fields.active?.booleanValue;
        console.log(`Diet plan: ${name}, active: ${active}`);
      });
    }

  } catch (e) {
    console.error(e);
  }
}

run();
