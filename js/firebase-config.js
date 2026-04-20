import { GEMINI_KEY } from './env.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  getDocs,
  deleteDoc,
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
const db = getFirestore(app);
const USER_ID = "user_default";
const storage = getStorage(app);
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

export {
  db,
  USER_ID,
  storage,
  GEMINI_KEY,
  GEMINI_URL,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp
};
