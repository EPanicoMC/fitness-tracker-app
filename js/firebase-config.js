import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocFromCache,
  getDocsFromCache,
  setDoc,
  addDoc,
  getDocs,
  deleteDoc,
  deleteField,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyC7bm-wJAScIaQfelZkGP4C7kw_FKI4Gv8",
  authDomain: "fitness-tracker-app-b6792.firebaseapp.com",
  projectId: "fitness-tracker-app-b6792",
  storageBucket: "fitness-tracker-app-b6792.firebasestorage.app",
  messagingSenderId: "458513477303",
  appId: "1:458513477303:web:11c284ec5505e12a846732"
};

const app = initializeApp(firebaseConfig);
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
} catch (e) {
  console.warn("Failed to initialize Firestore with persistent local cache, falling back to standard Firestore:", e);
  db = getFirestore(app);
}
const auth = getAuth(app);
const storage = getStorage(app);



export function getUserId() { return auth?.currentUser?.email?.toLowerCase(); }
export {
  app,
  db,
  auth,
  storage,
  collection,
  doc,
  getDoc,
  getDocFromCache,
  getDocsFromCache,
  setDoc,
  addDoc,
  getDocs,
  deleteDoc,
  deleteField,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence
};
