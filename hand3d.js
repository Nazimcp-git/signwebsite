/**
 * hand3d.js -- Interactive 3D Sign Language Hand Visualizer
 * Built with Three.js (WebGL).
 * 
 * Features:
 * 1. 3D Anatomical / Cybernetic Hand model with 5 articulated fingers & joints.
 * 2. Real-time kinematic bending mapped to flex sensor counts (Thumb to Little).
 * 3. 3-Axis wrist tilt (Pitch & Roll) driven by MPU6050 accelerometer gravity vectors.
 * 4. Smooth 60 FPS interpolation (lerp) for fluid motion between cloud updates.
 * 5. Interactive OrbitControls (click and drag to rotate/zoom the hand in 3D).
 */

class Hand3DVisualizer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      console.warn(`Container #${containerId} not found for 3D Hand.`);
      return;
    }

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;

    // Kinematic model nodes
    this.handRoot = null;
    this.fingers = []; // 5 fingers: [thumb, index, middle, ring, little]

    // Target values (updated from Firebase)
    // 0.0 = completely flat/open, 1.0 = fully bent
    this.targetBends = [0.0, 0.0, 0.0, 0.0, 0.0];
    this.currentBends = [0.0, 0.0, 0.0, 0.0, 0.0];

    // Target wrist rotation (radians)
    this.targetRot = { pitch: 0.0, roll: 0.0 };
    this.currentRot = { pitch: 0.0, roll: 0.0 };

    // Dynamic calibration & Auto-tare
    this.calibOpen = [1170.0, 1170.0, 1170.0, 1170.0, 1170.0];
    this.calibFist = [480.0, 480.0, 480.0, 480.0, 480.0];
    this.autoTareFrames = 0;
    this.autoTareAccum = [0, 0, 0, 0, 0];
    this.hasExplicitCalib = false;

    this.init();
  }

  init() {
    const width = this.container.clientWidth || 600;
    const height = this.container.clientHeight || 420;

    // 1. Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f172a); // Slate-900 high-tech dark background

    // 2. Camera setup
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    this.camera.position.set(0, 4.5, 9.5);

    // 3. Renderer setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // 4. Orbit Controls (Inspect hand from any angle)
    if (typeof THREE.OrbitControls !== "undefined") {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.maxPolarAngle = Math.PI * 0.85;
      this.controls.minDistance = 4;
      this.controls.maxDistance = 16;
    }

    // 5. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    this.scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0x38bdf8, 0.9); // Cyan directional light
    dirLight1.position.set(5, 10, 7);
    dirLight1.castShadow = true;
    this.scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x818cf8, 0.5); // Indigo fill light
    dirLight2.position.set(-5, -5, -4);
    this.scene.add(dirLight2);

    // 6. Grid floor
    const grid = new THREE.GridHelper(14, 28, 0x334155, 0x1e293b);
    grid.position.y = -2.8;
    this.scene.add(grid);

    // 7. Build Hand Model
    this.buildHandModel();

    // 8. Handle resize
    window.addEventListener("resize", () => this.onResize());

    // 9. Animation loop
    this.animate();
  }

  buildHandModel() {
    this.handRoot = new THREE.Group();
    this.handRoot.position.set(0, -0.5, 0);
    this.scene.add(this.handRoot);

    // Modern cybernetic styling materials
    const palmMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.35,
      metalness: 0.6
    });

    const jointMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7, // Vibrant cyan blue joints
      roughness: 0.2,
      metalness: 0.8
    });

    const fingerMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.4,
      metalness: 0.5
    });

    const tipMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.3,
      roughness: 0.2
    });

    // --- Palm Construction ---
    const palmGeo = new THREE.BoxGeometry(2.4, 2.8, 0.6);
    const palm = new THREE.Mesh(palmGeo, palmMat);
    palm.castShadow = true;
    palm.receiveShadow = true;
    this.handRoot.add(palm);

    // Wrist cuff
    const cuffGeo = new THREE.CylinderGeometry(1.0, 1.1, 0.8, 20);
    const cuff = new THREE.Mesh(cuffGeo, jointMat);
    cuff.position.set(0, -1.8, 0);
    this.handRoot.add(cuff);

    // MPU6050 sensor module mounted on back of hand
    const mpuGeo = new THREE.BoxGeometry(0.7, 0.7, 0.15);
    const mpuMat = new THREE.MeshStandardMaterial({ color: 0x10b981, metalness: 0.8 }); // Green PCB
    const mpuMesh = new THREE.Mesh(mpuGeo, mpuMat);
    mpuMesh.position.set(0, 0, -0.38);
    this.handRoot.add(mpuMesh);

    // --- Finger Kinematics ---
    // [Name, X offset, Y offset, Z offset, Length, Scale]
    const fingerConfigs = [
      { name: "thumb",  x: -1.4, y: -0.6, z: 0.15, segLen: 0.65, width: 0.38, isThumb: true },
      { name: "index",  x: -0.85, y: 1.45, z: 0,   segLen: 0.82, width: 0.34, isThumb: false },
      { name: "middle", x: -0.05, y: 1.55, z: 0,   segLen: 0.92, width: 0.35, isThumb: false },
      { name: "ring",   x: 0.75,  y: 1.45, z: 0,   segLen: 0.84, width: 0.33, isThumb: false },
      { name: "little", x: 1.45,  y: 1.25, z: 0,   segLen: 0.68, width: 0.30, isThumb: false }
    ];

    this.fingers = [];

    fingerConfigs.forEach(cfg => {
      const finger = this.createFinger(cfg, palmMat, jointMat, fingerMat, tipMat);
      this.handRoot.add(finger.baseGroup);
      this.fingers.push(finger);
    });
  }

  createFinger(cfg, palmMat, jointMat, fingerMat, tipMat) {
    const baseGroup = new THREE.Group();
    baseGroup.position.set(cfg.x, cfg.y, cfg.z);

    if (cfg.isThumb) {
      // Rotate thumb base outward for natural human opposition
      baseGroup.rotation.z = Math.PI * 0.22;
      baseGroup.rotation.y = Math.PI * 0.15;
    }

    const segments = [];
    let parentGroup = baseGroup;
    const numSegments = 3;

    for (let s = 0; s < numSegments; s++) {
      const len = cfg.segLen * (s === 0 ? 1.0 : s === 1 ? 0.85 : 0.7);
      const radius = cfg.width * (1.0 - s * 0.15);

      // Knuckle Joint (Sphere)
      const jointGeo = new THREE.SphereGeometry(radius * 1.1, 14, 14);
      const jointMesh = new THREE.Mesh(jointGeo, jointMat);
      jointMesh.castShadow = true;
      parentGroup.add(jointMesh);

      // Bone Phalanx (Cylinder)
      const boneGeo = new THREE.CylinderGeometry(radius * 0.9, radius, len, 14);
      const mat = (s === numSegments - 1) ? tipMat : fingerMat;
      const boneMesh = new THREE.Mesh(boneGeo, mat);
      boneMesh.position.y = len / 2;
      boneMesh.castShadow = true;
      parentGroup.add(boneMesh);

      // Sub-joint node for hierarchical bending
      const nextGroup = new THREE.Group();
      nextGroup.position.y = len;
      parentGroup.add(nextGroup);

      segments.push(parentGroup);
      parentGroup = nextGroup;
    }

    return {
      name: cfg.name,
      baseGroup,
      segments, // Joint groups that will rotate
      isThumb: cfg.isThumb
    };
  }

  /**
   * Updates target values from Firebase telemetry
   * @param {Object} tel: { f1..f5, ax, ay, az }
   */
  updateTelemetry(tel) {
    if (!tel) return;

    const rawF = [tel.f1 || 1170, tel.f2 || 1165, tel.f3 || 1180, tel.f4 || 1172, tel.f5 || 1168];

    // Smart auto-tare on boot for resting position
    if (!this.hasExplicitCalib && this.autoTareFrames < 6) {
      for (let i = 0; i < 5; i++) this.autoTareAccum[i] += rawF[i];
      this.autoTareFrames++;
      if (this.autoTareFrames === 6) {
        for (let i = 0; i < 5; i++) this.calibOpen[i] = this.autoTareAccum[i] / 6.0;
        this.hasExplicitCalib = true;
      }
    }

    // Convert raw ADC counts using Absolute Delta deviation from resting flat baseline
    for (let i = 0; i < 5; i++) {
      const diff = Math.abs(rawF[i] - this.calibOpen[i]);
      const norm = Math.min(1.0, Math.max(0.0, diff / 250.0));
      this.targetBends[i] = norm;
    }

    // Convert accelerometer gravity vector to pitch and roll
    if (tel.ax !== undefined && tel.ay !== undefined && tel.az !== undefined) {
      // Pitch: rotation around X axis (forward/backward tilt)
      const pitch = Math.atan2(tel.ax, Math.sqrt(tel.ay * tel.ay + tel.az * tel.az));
      // Roll: rotation around Z axis (left/right wrist roll)
      const roll = Math.atan2(tel.ay, tel.az);

      this.targetRot.pitch = pitch;
      this.targetRot.roll = roll * 0.8;
    }
  }

  /**
   * Sets manual pose for demonstration buttons
   */
  setPose(bends, pitch = 0, roll = 0) {
    for (let i = 0; i < 5; i++) {
      this.targetBends[i] = bends[i];
    }
    this.targetRot.pitch = pitch;
    this.targetRot.roll = roll;
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    const lerpFactor = 0.12; // Smooth 60 FPS transition

    // 1. Interpolate and apply finger bends
    for (let i = 0; i < 5; i++) {
      this.currentBends[i] += (this.targetBends[i] - this.currentBends[i]) * lerpFactor;
      const b = this.currentBends[i];
      const finger = this.fingers[i];

      if (finger) {
        // Bend angles across the 3 joints
        const angle = b * (Math.PI * 0.52); // ~93 degrees max bend

        if (finger.isThumb) {
          finger.segments[0].rotation.x = angle * 0.55;
          finger.segments[0].rotation.y = angle * 0.35;
          finger.segments[1].rotation.x = angle * 0.65;
          finger.segments[2].rotation.x = angle * 0.50;
        } else {
          finger.segments[0].rotation.x = angle * 0.50; // Metacarpophalangeal
          finger.segments[1].rotation.x = angle * 0.35; // Proximal
          finger.segments[2].rotation.x = angle * 0.25; // Distal
        }
      }
    }

    // 2. Interpolate and apply wrist tilt
    this.currentRot.pitch += (this.targetRot.pitch - this.currentRot.pitch) * lerpFactor;
    this.currentRot.roll += (this.targetRot.roll - this.currentRot.roll) * lerpFactor;

    if (this.handRoot) {
      this.handRoot.rotation.x = this.currentRot.pitch;
      this.handRoot.rotation.z = -this.currentRot.roll;
    }

    // 3. Update orbit controls
    if (this.controls) {
      this.controls.update();
    }

    this.renderer.render(this.scene, this.camera);
  }

  onResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight || 420;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  resetCamera() {
    if (this.camera && this.controls) {
      this.camera.position.set(0, 4.5, 9.5);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }
}

// Global visualizer instance
window.hand3d = null;

window.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("hand-3d-canvas")) {
    window.hand3d = new Hand3DVisualizer("hand-3d-canvas");
  }
});
