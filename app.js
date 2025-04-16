const APP_ID = "2a25041a57024e289c67c36418eace00";
const TOKEN = null;
const DEFAULT_CHANNEL = "test";

const labelMap = ["1L", "1R", "2L", "2R", "3L", "3R", "4L", "4R", "5R", "6L", "6R", "7L", "7R", "8L", "8R", "9L", "9R", "A", "B", "C", "D", "L"];
const CONFIDENCE_THRESHOLD = 0.7;
const PREDICTION_INTERVAL = 500;

const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

const videoGrid = document.getElementById("video-grid");
const participantCount = document.getElementById("participant-count");
const leaveBtn = document.getElementById("leave-btn");
const roomIdInput = document.getElementById("room-id-input");
const status = document.getElementById("status");
const micBtn = document.getElementById("mic-btn");
const audioControls = document.getElementById("audio-controls");

const remoteGestureSpan = document.getElementById("remote-gesture");

const ws = new WebSocket("wss://skitter-rural-slipper.glitch.me/");

ws.onopen = () => {
  console.log("✅ WebSocket connected");
  status.textContent += " | ✅ WebSocket connected";
};

ws.onerror = (err) => {
  console.error("❌ WebSocket error:", err);
  status.textContent += " | ❌ WebSocket error";
};

ws.onclose = () => {
  console.warn("🔌 WebSocket disconnected");
  status.textContent += " | 🔌 WebSocket disconnected";
};

let gestureTimeout;
function updateRemoteGestureDisplay(gesture) {
  if (remoteGestureSpan) remoteGestureSpan.textContent = gesture || "Not received";

  clearTimeout(gestureTimeout);
  gestureTimeout = setTimeout(() => {
    remoteGestureSpan.textContent = "Not received";
  }, 5000);
}

ws.onmessage = async (event) => {
  try {
    let data;

    if (event.data instanceof Blob) {
      const text = await event.data.text();
      data = JSON.parse(text);
    } else {
      data = JSON.parse(event.data);
    }

    const { type, gesture, from } = data;

    if (type === "gesture" && from !== localUid) {
      const label = document.getElementById(`label-remote-${from}`);
      if (label) label.textContent = `Gesture: ${gesture}`;
      updateRemoteGestureDisplay(gesture);
    }
  } catch (err) {
    console.warn("WebSocket message parse error:", err);
  }
};

let model, localVideoTrack, localAudioTrack, localUid;
let participants = new Set();
let lastPredictionTime = 0;

const hands = new Hands({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
hands.setOptions({
  maxNumHands: 2,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
});
hands.onResults(onResults);

async function joinCall() {
  const CHANNEL = roomIdInput.value.trim() || DEFAULT_CHANNEL;
  status.textContent = "Loading model...";
  model = await tf.loadLayersModel("landmark_model_tfjs/model.json");

  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

  const gestureVideo = document.createElement("video");
  gestureVideo.srcObject = stream;
  gestureVideo.muted = true;
  gestureVideo.playsInline = true;
  gestureVideo.play();

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

  // Create video and audio tracks separately
  localVideoTrack = await AgoraRTC.createCameraVideoTrack({ videoSource: stream.getVideoTracks()[0] });
  localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({ microphoneId: stream.getAudioTracks()[0].id });

  status.textContent = "Joining call...";
  localUid = await client.join(APP_ID, CHANNEL, TOKEN, null);
  await client.publish([localVideoTrack, localAudioTrack]);

  createVideoBox("local", "You");
  localVideoTrack.play("local");
  participants.add("local");
  updateParticipantCount();
  setupListeners();

  leaveBtn.disabled = false;
  roomIdInput.disabled = true;
  status.textContent = `In call: ${CHANNEL}`;
  audioControls.style.display = "flex";
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
    document.getElementById(`box-${id}`)?.remove();
    participants.delete(id);
    updateParticipantCount();
  });

  client.on("user-left", user => {
    const id = `remote-${user.uid}`;
    document.getElementById(`box-${id}`)?.remove();
    participants.delete(id);
    updateParticipantCount();
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

function updateParticipantCount() {
  participantCount.textContent = `Participants: ${participants.size}`;
}

function toggleMic() {
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

      document.getElementById("label-local").textContent = `Gesture: ${gesture}`;
      sendGesture(gesture);
    }).catch(err => console.error("Prediction error:", err))
    .finally(() => {
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
    console.log(`📤 Sent gesture to WebSocket: ${gesture}`);
  }
}

async function leaveCall() {
  await client.leave();
  localVideoTrack?.stop();
  localVideoTrack?.close();
  localAudioTrack?.stop();
  localAudioTrack?.close();
  videoGrid.innerHTML = "";
  participants.clear();
  updateParticipantCount();
  leaveBtn.disabled = true;
  roomIdInput.disabled = false;
  status.textContent = "Left call";
  audioControls.style.display = "none";
  micBtn.textContent = "Mic On";
  micBtn.classList.remove("muted");
}