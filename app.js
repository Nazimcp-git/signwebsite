/**
 * Sign Language Glove - Cloud Layer Web Application
 * Handles:
 * 1. Public Reader: Live feed of approved spoken phrases from Firestore
 * 2. Admin Portal: Authentication, reviewing private records, approving/rejecting
 * 3. Text-To-Speech: Browser SpeechSynthesis integration
 * 4. Fallback / Mock Mode: Allows immediate testing even before Firebase setup
 */

// Replace with your Firebase project config from Step 3.2
const firebaseConfig = {
  apiKey: "AIzaSyBXJ_RnfjUDi7qPDATWVnS5lSFw6jVRYgo",
  authDomain: "shopping-e284c.firebaseapp.com",
  databaseURL: "https://shopping-e284c-default-rtdb.firebaseio.com",
  projectId: "shopping-e284c",
  storageBucket: "shopping-e284c.appspot.com",
  messagingSenderId: "248274428739",
  appId: "1:248274428739:web:fc30dd9eb1ef83f610c5f6",
  measurementId: "G-ZXZCK9BW7T"
};

// Application State
let db = null;
let rtdb = null;
let auth = null;
let isFirebaseLive = false;
let isAdminMode = false;
let currentCategory = "all";
let searchQuery = "";
let autoSpeakEnabled = true;

// In-Memory dataset for demo/fallback mode
let memoryRecords = [
  {
    id: "rec-001",
    text: "HELLO",
    class: "hello",
    category: "Daily needs",
    confidence: 0.94,
    status: "approved",
    timestamp: new Date(Date.now() - 3600000 * 2)
  },
  {
    id: "rec-002",
    text: "WATER",
    class: "water",
    category: "Daily needs",
    confidence: 0.89,
    status: "approved",
    timestamp: new Date(Date.now() - 3600000 * 1)
  },
  {
    id: "rec-003",
    text: "I NEED HELP",
    class: "need_help",
    category: "Emergency",
    confidence: 0.97,
    status: "approved",
    timestamp: new Date(Date.now() - 1000 * 60 * 15)
  },
  {
    id: "rec-pending-1",
    text: "WHERE IS THE TOILET",
    class: "toilet",
    category: "Daily needs",
    confidence: 0.86,
    status: "private",
    timestamp: new Date(Date.now() - 1000 * 60 * 3)
  },
  {
    id: "rec-pending-2",
    text: "PLEASE",
    class: "please",
    category: "Daily needs",
    confidence: 0.91,
    status: "private",
    timestamp: new Date(Date.now() - 1000 * 60)
  }
];

// Initialize DOM elements
const readerSection = document.getElementById("reader-section");
const hand3dSection = document.getElementById("hand3d-section");
const adminSection = document.getElementById("admin-section");
const navTabReader = document.getElementById("nav-tab-reader");
const navTabHand3d = document.getElementById("nav-tab-hand3d");
const navTabAdmin = document.getElementById("nav-tab-admin");
const phrasesFeed = document.getElementById("phrases-feed");
const adminFeed = document.getElementById("admin-feed");
const statTotal = document.getElementById("stat-total");
const statEmergency = document.getElementById("stat-emergency");
const searchInput = document.getElementById("phrase-search");
const tabButtons = document.querySelectorAll(".tab-btn");
const autoSpeakToggle = document.getElementById("auto-speak-toggle");
const statusBar = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const loginModal = document.getElementById("login-modal");
const closeLoginBtn = document.getElementById("close-login-btn");
const loginForm = document.getElementById("login-form");
const demoLoginBtn = document.getElementById("demo-login-btn");
const authLogoutBtn = document.getElementById("auth-logout-btn");
const adminUserDisplay = document.getElementById("admin-user-display");
const resetCamBtn = document.getElementById("reset-cam-btn");
const pose3dText = document.getElementById("3d-pose-text");
const pose3dDesc = document.getElementById("3d-pose-desc");

// Tracking for real-time speech and duplicates
let knownRecordKeys = new Set();
let isInitialLoad = true;
let currentHeroPhrase = "READY FOR SIGNS";

// Connect to Local SSE Event Stream (Direct UDP from Glove via web_server.py)
function initLocalEventStream() {
  try {
    const sse = new EventSource("/api/events");
    sse.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "phrase") {
          onNewMessageReceived(data);
        } else if (data.type === "telemetry") {
          updateTelemetryUI({
            f1: data.f[0], f2: data.f[1], f3: data.f[2], f4: data.f[3], f5: data.f[4],
            ax: data.acc[0], ay: data.acc[1], az: data.acc[2],
            rssi: data.rssi
          });
        }
      } catch (e) {}
    };
    sse.onopen = function() {
      if (statusText) statusText.innerHTML = "Connected &middot; Local Direct UDP Bridge Active (0ms)";
    };
  } catch (e) {
    console.log("Local SSE stream not active; using cloud sync.");
  }
}

// Update the Latest Message Hero Card
function updateHeroBanner(phrase, category, source) {
  currentHeroPhrase = phrase;
  const heroCard = document.getElementById("latest-hero");
  const heroText = document.getElementById("hero-text");
  const heroTime = document.getElementById("hero-time");
  const heroCat = document.getElementById("hero-cat-badge");
  const heroSrc = document.getElementById("hero-source");

  if (!heroCard || !heroText) return;

  heroText.textContent = `"${phrase}"`;
  if (heroTime) heroTime.textContent = new Date().toLocaleTimeString();
  if (heroCat) {
    heroCat.textContent = category || "Daily needs";
    heroCat.className = `badge ${category === "Emergency" ? "emergency" : "daily"}`;
  }
  if (heroSrc) heroSrc.textContent = `Source: ${source || "Glove AI Engine"}`;

  if (category === "Emergency" || phrase.includes("HELP")) {
    heroCard.classList.add("hero-emergency");
  } else {
    heroCard.classList.remove("hero-emergency");
  }
}

function speakCurrentHero() {
  if (currentHeroPhrase && currentHeroPhrase !== "READY FOR SIGNS") {
    speakText(currentHeroPhrase);
  }
}

// Trigger phrase from Soundboard buttons
function triggerPhrase(track, phrase) {
  // 1. Speak aloud immediately
  speakText(phrase);

  // 2. Update UI
  const isEmerg = (track === 8 || phrase.includes("HELP"));
  const cat = isEmerg ? "Emergency" : "Daily needs";
  onNewMessageReceived({
    id: `local-${Date.now()}`,
    text: phrase,
    category: cat,
    confidence: 0.99,
    status: "approved",
    source: "Web Soundboard Simulator",
    timestamp: new Date()
  });

  // 3. Send remote trigger to ESP32 over local API
  fetch(`/api/trigger?track=${track}`).catch(() => {});
}

// Central handler for new message from any source (UDP, Firebase, Soundboard)
function onNewMessageReceived(item) {
  const phrase = item.text;
  if (!phrase) return;

  // Add to in-memory records
  const existing = memoryRecords.find(r => r.text === phrase && Math.abs(new Date(r.timestamp) - new Date(item.timestamp || Date.now())) < 2000);
  if (!existing) {
    memoryRecords.unshift({
      id: item.id || `rec-${Date.now()}`,
      text: phrase,
      category: item.category || "Daily needs",
      confidence: item.confidence || 0.95,
      status: "approved",
      source: item.source || "Glove AI Engine",
      timestamp: item.timestamp ? new Date(item.timestamp) : new Date()
    });
  }

  // Update Hero Card
  updateHeroBanner(phrase, item.category, item.source);

  // Render feed
  renderAll();

  // Auto-speak if enabled
  if (autoSpeakToggle && autoSpeakToggle.checked) {
    speakText(phrase);
  }
}

// Initialize Firebase
function initFirebase() {
  initLocalEventStream();

  try {
    if (typeof firebase !== "undefined" && firebaseConfig.apiKey !== "AIzaSy_YOUR_API_KEY") {
      firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      rtdb = firebase.database ? firebase.database() : null;
      isFirebaseLive = true;
      if (statusText) statusText.innerHTML = "Connected &middot; Live Firebase Realtime Stream Active";

      if (rtdb) listenToRealtimeDatabase();
      return;
    }
  } catch (err) {
    console.warn("Firebase live init skipped, falling back to local demo mode:", err);
  }

  // Fallback to local demo mode
  isFirebaseLive = false;
  if (statusText) statusText.innerHTML = "Local Mode Active &middot; Listening for UDP glove packets";
  renderAll();
  startDemoTelemetry();
}

// Firebase Realtime Database Listener (Listens to ESP32 direct uploads)
function listenToRealtimeDatabase() {
  if (!rtdb) return;

  // Listen for phrases directly uploaded by ESP32 glove
  rtdb.ref("records").limitToLast(50).on("value", snapshot => {
    const val = snapshot.val();
    if (!val) return;
    const rtdbRecords = [];
    let newest = null;

    Object.keys(val).forEach(k => {
      const item = val[k];
      const rec = {
        id: k,
        text: item.text,
        category: item.category || "Daily needs",
        confidence: item.confidence || 0.95,
        status: item.status || "approved",
        source: item.source || "glove_esp32",
        timestamp: item.timestamp ? new Date(item.timestamp) : new Date()
      };
      rtdbRecords.push(rec);

      if (!knownRecordKeys.has(k)) {
        knownRecordKeys.add(k);
        if (!isInitialLoad) {
          newest = rec;
        }
      }
    });

    isInitialLoad = false;
    rtdbRecords.sort((a, b) => b.timestamp - a.timestamp);
    memoryRecords = rtdbRecords;

    if (memoryRecords.length > 0) {
      const top = memoryRecords[0];
      updateHeroBanner(top.text, top.category, top.source);
    }
    renderAll();

    if (newest && autoSpeakToggle && autoSpeakToggle.checked) {
      speakText(newest.text);
    }
  });

  // Listen for live glove sensor telemetry (0.5 Hz)
  rtdb.ref("live_telemetry").on("value", snapshot => {
    const tel = snapshot.val();
    if (tel) {
      updateTelemetryUI(tel);
      if (statusText) {
        statusText.innerHTML = `Connected &middot; Glove Online (RSSI: ${tel.rssi || -60}dBm &middot; Live Telemetry Synced)`;
      }
    }
  });
}

// Update the live finger telemetry panel
function updateTelemetryUI(tel) {
  if (!tel) return;
  const f = [tel.f1 || 1170, tel.f2 || 1165, tel.f3 || 1180, tel.f4 || 1172, tel.f5 || 1168];

  // Convert ADC counts (1170 = open hand, 480 = tight fist) into 10%..95% visual height
  f.forEach((val, idx) => {
    const fingerNum = idx + 1;
    const bar = document.getElementById(`bar-f${fingerNum}`);
    const text = document.getElementById(`val-f${fingerNum}`);
    if (bar && text) {
      let pct = Math.round(((1170 - val) / (1170 - 480)) * 100);
      pct = Math.max(10, Math.min(95, pct));
      bar.style.height = `${pct}%`;
      text.textContent = `${Math.round(val)}`;
    }
  });

  const sig = document.getElementById("telemetry-signal");
  if (sig && tel.rssi !== undefined) {
    sig.textContent = `Wi-Fi: ${tel.rssi} dBm`;
  }

  const accElem = document.getElementById("val-acc");
  if (accElem && tel.ax !== undefined) {
    accElem.textContent = `[${tel.ax.toFixed(2)}, ${tel.ay.toFixed(2)}, ${tel.az.toFixed(2)}] g`;
  }

  const tiltElem = document.getElementById("val-tilt");
  if (tiltElem && tel.az !== undefined) {
    if (tel.az > 0.6) tiltElem.textContent = "Flat (Palm Down)";
    else if (tel.az < -0.6) tiltElem.textContent = "Flat (Palm Up)";
    else if (tel.ax > 0.6) tiltElem.textContent = "Upright (Fingers Up)";
    else tiltElem.textContent = "Angled / Tilted";
  }

  // Update 3D Hand Model kinematics
  if (window.hand3d) {
    window.hand3d.updateTelemetry(tel);
  }
}

// Demo telemetry simulator for testing without hardware
let demoSimTimer = null;
function startDemoTelemetry() {
  if (demoSimTimer) clearInterval(demoSimTimer);
  let step = 0;
  demoSimTimer = setInterval(() => {
    if (isFirebaseLive) {
      clearInterval(demoSimTimer);
      return;
    }
    step = (step + 1) % 4;
    // Simulate gentle finger variations
    const bendFactors = [
      [1170, 1165, 1180, 1172, 1168],  // Flat open
      [1050, 950, 1000, 1100, 1150],   // Index pointing
      [520, 500, 510, 530, 520],       // Fist
      [1170, 500, 510, 520, 1168]      // Help sign (thumb + pinky open)
    ];
    const accVariations = [
      { ax: 0.05, ay: -0.02, az: 0.98 },
      { ax: 0.85, ay: 0.01, az: 0.25 },
      { ax: 0.10, ay: -0.05, az: 0.95 },
      { ax: 0.92, ay: 0.00, az: 0.15 }
    ];
    const b = bendFactors[step];
    const a = accVariations[step];
    updateTelemetryUI({
      f1: b[0], f2: b[1], f3: b[2], f4: b[3], f5: b[4],
      ax: a.ax, ay: a.ay, az: a.az,
      rssi: -58 - (step * 3)
    });
  }, 2500);
}

// Firestore Realtime Listener
function listenToFirestore() {
  // 1. Listen for approved records (Public Reader)
  db.collection("records")
    .where("status", "==", "approved")
    .orderBy("timestamp", "desc")
    .onSnapshot(snapshot => {
      const records = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        records.push({
          id: doc.id,
          ...data,
          timestamp: data.timestamp ? data.timestamp.toDate() : new Date()
        });
      });
      memoryRecords = records.concat(memoryRecords.filter(r => r.status === "private"));
      renderAll();
    }, err => {
      console.error("Firestore approved records error:", err);
    });

  // 2. Listen for private records (Admin Queue)
  db.collection("records")
    .where("status", "==", "private")
    .orderBy("timestamp", "desc")
    .onSnapshot(snapshot => {
      const privates = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        privates.push({
          id: doc.id,
          ...data,
          timestamp: data.timestamp ? data.timestamp.toDate() : new Date()
        });
      });
      memoryRecords = memoryRecords.filter(r => r.status === "approved").concat(privates);
      renderAll();
    }, err => {
      console.error("Firestore private records error:", err);
    });
}

// Speech Synthesis
function speakText(text) {
  if (!("speechSynthesis" in window)) {
    alert("Speech synthesis not supported on this browser.");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

// Render Public Approved Feed
function renderPublicFeed() {
  const approved = memoryRecords.filter(r => r.status === "approved");

  // Update stats
  statTotal.textContent = approved.length;
  statEmergency.textContent = approved.filter(r => r.category === "Emergency").length;

  // Filter
  const filtered = approved.filter(r => {
    const matchesCat = (currentCategory === "all" || r.category === currentCategory);
    const matchesSearch = !searchQuery || r.text.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCat && matchesSearch;
  });

  if (filtered.length === 0) {
    phrasesFeed.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>No matching approved phrases found.</p>
      </div>`;
    return;
  }

  phrasesFeed.innerHTML = filtered.map(r => {
    const isEmerg = r.category === "Emergency";
    const timeFormatted = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const confPct = Math.round((r.confidence || 0.90) * 100);

    return `
      <div class="phrase-card ${isEmerg ? 'emergency-card' : ''}">
        <div class="card-left">
          <div class="phrase-text">${escapeHtml(r.text)}</div>
          <div class="meta-row">
            <span class="badge ${isEmerg ? 'emergency' : 'daily'}">${escapeHtml(r.category)}</span>
            <span>&bull; ${timeFormatted}</span>
            <span>&bull; Confidence: ${confPct}%</span>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm btn-listen" onclick="speakText('${escapeHtml(r.text)}')">
            🔊 Listen
          </button>
        </div>
      </div>
    `;
  }).join("");
}

// Render Admin Review Queue
function renderAdminQueue() {
  const pending = memoryRecords.filter(r => r.status === "private");

  if (pending.length === 0) {
    adminFeed.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎉</div>
        <p>No pending sign captures. All records reviewed!</p>
      </div>`;
    return;
  }

  adminFeed.innerHTML = pending.map(r => {
    const timeFormatted = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const confPct = Math.round((r.confidence || 0.85) * 100);

    return `
      <div class="phrase-card">
        <div class="card-left">
          <div class="phrase-text">${escapeHtml(r.text)}</div>
          <div class="meta-row">
            <span class="badge pending">Private (Pending Review)</span>
            <span>Category: ${escapeHtml(r.category)}</span>
            <span>&bull; Captured: ${timeFormatted}</span>
            <span>&bull; Conf: ${confPct}%</span>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm btn-listen" onclick="speakText('${escapeHtml(r.text)}')">
            🔊
          </button>
          <button class="btn btn-sm btn-approve" onclick="approveRecord('${r.id}')">
            ✓ Approve
          </button>
          <button class="btn btn-sm btn-reject" onclick="rejectRecord('${r.id}')">
            ✕ Reject
          </button>
        </div>
      </div>
    `;
  }).join("");
}

function renderAll() {
  renderPublicFeed();
  renderAdminQueue();
}

// Approve action
window.approveRecord = async function (id) {
  if (isFirebaseLive && db) {
    try {
      await db.collection("records").doc(id).update({
        status: "approved",
        reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
        reviewedBy: auth.currentUser ? auth.currentUser.email : "admin"
      });
    } catch (err) {
      alert("Firestore error updating record: " + err.message);
    }
  } else {
    // Local memory update
    const rec = memoryRecords.find(r => r.id === id);
    if (rec) {
      rec.status = "approved";
      rec.reviewedAt = new Date();
      if (autoSpeakEnabled) {
        speakText(rec.text);
      }
      renderAll();
    }
  }
};

// Reject action
window.rejectRecord = async function (id) {
  if (isFirebaseLive && db) {
    try {
      await db.collection("records").doc(id).update({
        status: "rejected",
        reviewedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (err) {
      alert("Firestore error updating record: " + err.message);
    }
  } else {
    // Local memory update
    const rec = memoryRecords.find(r => r.id === id);
    if (rec) {
      rec.status = "rejected";
      renderAll();
    }
  }
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

// Navigation & View Switching
function switchTab(tabName) {
  // Reset active classes
  [readerSection, hand3dSection, adminSection].forEach(s => s && s.classList.remove("active"));
  [navTabReader, navTabHand3d, navTabAdmin].forEach(b => b && b.classList.remove("active"));

  if (tabName === "reader") {
    readerSection.classList.add("active");
    navTabReader.classList.add("active");
  } else if (tabName === "hand3d") {
    hand3dSection.classList.add("active");
    navTabHand3d.classList.add("active");
    // Trigger 3D canvas resize when revealed
    if (window.hand3d) {
      setTimeout(() => window.hand3d.onResize(), 50);
    }
  } else if (tabName === "admin") {
    if (isFirebaseLive && (!auth.currentUser || auth.currentUser.isAnonymous)) {
      loginModal.classList.remove("hidden");
    } else {
      adminSection.classList.add("active");
      navTabAdmin.classList.add("active");
    }
  }
}

navTabReader.addEventListener("click", () => switchTab("reader"));
navTabHand3d.addEventListener("click", () => switchTab("hand3d"));
navTabAdmin.addEventListener("click", () => switchTab("admin"));

if (resetCamBtn) {
  resetCamBtn.addEventListener("click", () => {
    if (window.hand3d) window.hand3d.resetCamera();
  });
}

// 10 Interactive Sign Language Poses (matching vocab.json)
const POSE_LIBRARY = {
  neutral: {
    name: "NEUTRAL (IDLE)",
    desc: "Fingers flat & open &bull; Palm facing down",
    bends: [0.0, 0.0, 0.0, 0.0, 0.0],
    pitch: 0.0,
    roll: 0.0,
    phrase: ""
  },
  hello: {
    name: "HELLO",
    desc: "Fingers flat & open &bull; Hand upright (facing viewer)",
    bends: [0.0, 0.0, 0.0, 0.0, 0.0],
    pitch: 1.50, // 86 degrees upright
    roll: 0.0,
    phrase: "HELLO"
  },
  thank_you: {
    name: "THANK YOU",
    desc: "Fingers flat & open &bull; Palm facing UP",
    bends: [0.0, 0.0, 0.0, 0.0, 0.0],
    pitch: 0.0,
    roll: Math.PI, // 180 degrees palm up
    phrase: "THANK YOU"
  },
  yes: {
    name: "YES",
    desc: "Closed fist &bull; Level hand",
    bends: [1.0, 1.0, 1.0, 1.0, 1.0],
    pitch: 0.0,
    roll: 0.0,
    phrase: "YES"
  },
  no: {
    name: "NO",
    desc: "Index & Middle forward &bull; Others bent",
    bends: [1.0, 0.0, 0.0, 1.0, 1.0],
    pitch: 0.0,
    roll: 0.0,
    phrase: "NO"
  },
  please: {
    name: "PLEASE",
    desc: "Thumb out &bull; 4 fingers curled in a fist",
    bends: [0.0, 1.0, 1.0, 1.0, 1.0],
    pitch: 0.0,
    roll: 0.0,
    phrase: "PLEASE"
  },
  water: {
    name: "WATER",
    desc: "Three fingers upright (Index, Middle, Ring) &bull; 'W' shape",
    bends: [1.0, 0.0, 0.0, 0.0, 1.0],
    pitch: 1.25,
    roll: 0.15,
    phrase: "WATER"
  },
  food: {
    name: "FOOD",
    desc: "All fingers half-curled &bull; Hand tilted 45°",
    bends: [0.55, 0.55, 0.55, 0.55, 0.55],
    pitch: 0.75,
    roll: 0.0,
    phrase: "FOOD"
  },
  need_help: {
    name: "I NEED HELP",
    desc: "Thumb & Little finger extended &bull; 3 middle bent ('Call' sign)",
    bends: [0.0, 1.0, 1.0, 1.0, 0.0],
    pitch: 1.35,
    roll: 0.0,
    phrase: "I NEED HELP"
  },
  toilet: {
    name: "WHERE IS THE TOILET",
    desc: "Index & Little finger extended ('Horns' pose) &bull; Level hand",
    bends: [1.0, 0.0, 1.0, 1.0, 0.0],
    pitch: 0.0,
    roll: 0.0,
    phrase: "WHERE IS THE TOILET"
  }
};

window.demoPose = function(poseKey) {
  const pose = POSE_LIBRARY[poseKey];
  if (!pose) return;

  if (window.hand3d) {
    window.hand3d.setPose(pose.bends, pose.pitch, pose.roll);
  }

  // Update overlay text
  if (pose3dText) pose3dText.textContent = pose.name;
  if (pose3dDesc) pose3dDesc.innerHTML = pose.desc;

  // Speak phrase if enabled
  if (pose.phrase && autoSpeakEnabled) {
    speakText(pose.phrase);
  }

  // Also update finger bar heights to match
  pose.bends.forEach((bend, idx) => {
    const fingerNum = idx + 1;
    const bar = document.getElementById(`bar-f${fingerNum}`);
    const text = document.getElementById(`val-f${fingerNum}`);
    if (bar && text) {
      const pct = Math.round(10 + bend * 85);
      bar.style.height = `${pct}%`;
      const fakeAdc = Math.round(1170 - bend * (1170 - 480));
      text.textContent = `${fakeAdc}`;
    }
  });
};

closeLoginBtn.addEventListener("click", () => {
  loginModal.classList.add("hidden");
});

demoLoginBtn.addEventListener("click", () => {
  loginModal.classList.add("hidden");
  adminSection.classList.add("active");
  navTabAdmin.classList.add("active");
});

loginForm.addEventListener("submit", async e => {
  e.preventDefault();
  const email = document.getElementById("admin-email").value;
  const password = document.getElementById("admin-password").value;

  if (isFirebaseLive && auth) {
    try {
      await auth.signInWithEmailAndPassword(email, password);
      loginModal.classList.add("hidden");
      adminSection.classList.add("active");
      navTabAdmin.classList.add("active");
    } catch (err) {
      alert("Sign in failed: " + err.message);
    }
  } else {
    loginModal.classList.add("hidden");
    adminSection.classList.add("active");
    navTabAdmin.classList.add("active");
  }
});

authLogoutBtn.addEventListener("click", async () => {
  if (isFirebaseLive && auth) {
    await auth.signOut();
  }
  switchTab("reader");
});

searchInput.addEventListener("input", e => {
  searchQuery = e.target.value.trim();
  renderPublicFeed();
});

tabButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    tabButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentCategory = btn.dataset.category;
    renderPublicFeed();
  });
});

autoSpeakToggle.addEventListener("change", e => {
  autoSpeakEnabled = e.target.checked;
});

// Boot up
window.addEventListener("DOMContentLoaded", () => {
  initFirebase();
});

