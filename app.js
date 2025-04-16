const APP_ID = "2a25041a57024e289e67c36418eace00";
const TOKEN = null;
const DEFAULT_CHANNEL = "test";

// Gesture recognition variables
const labelMap = ["1L", "1R", "2L", "2R", "3L", "3R", "4L", "4R", "5R", "6L", "6R", "7L", "7R", "8L", "8R", "9L", "9R", "A", "B", "C", "D", "L"];
const CONFIDENCE_THRESHOLD = 0.7;
const PREDICTION_INTERVAL = 500;

// DOM elements
const videoGrid = document.getElementById("video-grid");
const participantCount = document.getElementById("participant-count");
const leaveBtn = document.getElementById("leave-btn");
const roomIdInput = document.getElementById("room-id-input");
const status = document.getElementById("status");
const micBtn = document.getElementById("mic-btn");
const audioControls = document.getElementById("audio-controls");
const permissionWarning = document.getElementById("permission-warning");

// Agora and WebSocket setup
const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
const ws = new WebSocket("wss://skitter-rural-slipper.glitch.me/");

// Application state
let model, localVideoTrack, localAudioTrack, localUid;
let participants = new Set();
let lastPredictionTime = 0;
let mediaStream;

// MediaPipe Hands setup
const hands = new Hands({ 
  locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` 
});
hands.setOptions({
  maxNumHands: 2,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
});
hands.onResults(onResults);

// WebSocket handlers
ws.onopen = () => {
  console.log("✅ WebSocket connected");
  updateStatus("WebSocket connected");
};

ws.onerror = (err) => {
  console.error("❌ WebSocket error:", err);
  updateStatus("WebSocket error");
};

ws.onclose = () => {
  console.warn("🔌 WebSocket disconnected");
  updateStatus("WebSocket disconnected");
};

// Helper functions
function updateStatus(message) {
  status.textContent = message;
}

function updateRemoteGestureDisplay(gesture) {
  const remoteGestureSpan = document.getElementById("remote-gesture");
  if (remoteGestureSpan) {
    remoteGestureSpan.textContent = gesture || "Not received";
    clearTimeout(gestureTimeout);
    gestureTimeout = setTimeout(() => {
      remoteGestureSpan.textContent = "Not received";
    }, 5000);
  }
}

// Main call functions
async function joinCall() {
  try {
    const CHANNEL = roomIdInput.value.trim() || DEFAULT_CHANNEL;
    updateStatus("Requesting permissions...");
    
    // Check and request permissions
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ 
        video: true, 
        audio: true 
      });
      permissionWarning.style.display = "none";
    } catch (err) {
      console.error("Permission error:", err);
      permissionWarning.style.display = "block";
      updateStatus("Permission denied");
      return;
    }

    // Load gesture model (optional)
    updateStatus("Loading gesture model...");
    try {
      model = await tf.loadLayersModel("landmark_model_tfjs/model.json");
    } catch (err) {
      console.warn("Gesture model not loaded:", err);
      model = null;
    }

    // Setup gesture recognition if model loaded
    if (model) {
      const gestureVideo = document.createElement("video");
      gestureVideo.srcObject = mediaStream;
      gestureVideo.muted = true;
      gestureVideo.playsInline = true;
      await gestureVideo.play();

      const cam = new Camera(gestureVideo, {
        onFrame: async () => {
          const now = Date.now();
          if (now - lastPredictionTime > PREDICTION_INTERVAL) {
            await hands.send({ image: gestureVideo });
            lastPredictionTime = now;
          }
        },
        width: 640,
        height: 480,
      });
      cam.start();
    }

    // Create Agora tracks
    updateStatus("Setting up media tracks...");
    try {
      localVideoTrack = await AgoraRTC.createCameraVideoTrack({
        videoSource: mediaStream.getVideoTracks()[0]
      });
      
      localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
        microphoneId: mediaStream.getAudioTracks()[0].id
      });
    } catch (err) {
      console.error("Track creation failed:", err);
      updateStatus("Failed to create media tracks");
      cleanupMedia();
      return;
    }

    // Join channel
    updateStatus("Joining channel...");
    try {
      localUid = await client.join(APP_ID, CHANNEL, TOKEN, null);
      await client.publish([localVideoTrack, localAudioTrack]);
    } catch (err) {
      console.error("Join failed:", err);
      updateStatus("Failed to join channel");
      cleanupMedia();
      return;
    }

    // Setup UI
    createVideoBox("local", "You");
    localVideoTrack.play("local");
    participants.add("local");
    updateParticipantCount();
    setupListeners();

    leaveBtn.disabled = false;
    roomIdInput.disabled = true;
    audioControls.style.display = "flex";
    updateStatus(`In call: ${CHANNEL}`);

  } catch (err) {
    console.error("Join call failed:", err);
    updateStatus("Error: " + err.message);
    cleanupMedia();
  }
}

function setupListeners() {
  client.on("user-published", async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    
    if (mediaType === "video") {
      const id = `remote-${user.uid}`;
      createVideoBox(id, `User ${user.uid}`);
      user.videoTrack.play(id);
      participants.add(id);
      updateParticipantCount();
    }
    
    if (mediaType === "audio") {
      user.audioTrack.play();
    }
  });

  client.on("user-unpublished", user => {
    const id = `remote-${user.uid}`;
    removeVideoBox(id);
  });

  client.on("user-left", user => {
    const id = `remote-${user.uid}`;
    removeVideoBox(id);
  });
}

function createVideoBox(id, name) {
  if (document.getElementById(`box-${id}`)) return;

  const box = document.createElement("div");
  box.className = "video-box";
  box.id = `box-${id}`;

  const stream = document.createElement("div");
  stream.className = "video-stream";
  stream.id = id;

  const nameLabel = document.createElement("div");
  nameLabel.className = "user-name";
  nameLabel.textContent = name;

  const predictionLabel = document.createElement("div");
  predictionLabel.className = "prediction-label";
  predictionLabel.id = id === "local" ? "label-local" : `label-remote-${id.split("-")[1]}`;
  predictionLabel.textContent = "Gesture: None";

  box.appendChild(stream);
  box.appendChild(nameLabel);
  box.appendChild(predictionLabel);
  videoGrid.appendChild(box);
}

function removeVideoBox(id) {
  document.getElementById(`box-${id}`)?.remove();
  participants.delete(id);
  updateParticipantCount();
}

function updateParticipantCount() {
  participantCount.textContent = `Participants: ${participants.size}`;
}

// Media control functions
function toggleMic() {
  if (!localAudioTrack) return;
  
  if (localAudioTrack.muted) {
    localAudioTrack.setMuted(false);
    micBtn.textContent = "Mic On";
    micBtn.classList.remove("muted");
  } else {
    localAudioTrack.setMuted(true);
    micBtn.textContent = "Mic Off";
    micBtn.classList.add("muted");
  }
}

async function leaveCall() {
  try {
    updateStatus("Leaving call...");
    await client.leave();
    cleanupMedia();
    
    videoGrid.innerHTML = "";
    participants.clear();
    updateParticipantCount();
    
    leaveBtn.disabled = true;
    roomIdInput.disabled = false;
    audioControls.style.display = "none";
    updateStatus("Ready to join");
  } catch (err) {
    console.error("Leave failed:", err);
    updateStatus("Error leaving call");
  }
}

function cleanupMedia() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  localVideoTrack?.stop();
  localVideoTrack?.close();
  localAudioTrack?.stop();
  localAudioTrack?.close();
  localVideoTrack = null;
  localAudioTrack = null;
}

// Gesture recognition functions
function onResults(results) {
  if (!model) return;

  const landmarks = [];
  for (let i = 0; i < 2; i++) {
    if (results.multiHandLandmarks[i]) {
      for (const lm of results.multiHandLandmarks[i]) {
        landmarks.push(lm.x, lm.y, lm.z);
      }
    } else {
      for (let j = 0; j < 21; j++) landmarks.push(0, 0, 0);
    }
  }

  while (landmarks.length < 188) landmarks.push(0);

  if (landmarks.some(v => v !== 0)) {
    const input = tf.tensor2d([landmarks]);
    const prediction = model.predict(input);

    prediction.array().then(data => {
      const maxVal = Math.max(...data[0]);
      const maxIdx = data[0].indexOf(maxVal);
      const gesture = maxVal > CONFIDENCE_THRESHOLD ? labelMap[maxIdx] : "None";

      const labelElement = document.getElementById("label-local");
      if (labelElement) labelElement.textContent = `Gesture: ${gesture}`;
      sendGesture(gesture);
    }).catch(err => {
      console.error("Prediction error:", err);
    }).finally(() => {
      input.dispose();
      prediction.dispose();
    });
  }
}

function sendGesture(gesture) {
  if (ws.readyState === WebSocket.OPEN && localUid != null) {
    const msg = JSON.stringify({
      type: "gesture",
      gesture: gesture,
      from: localUid,
    });
    ws.send(msg);
    console.log(`Sent gesture: ${gesture}`);
  }
}
