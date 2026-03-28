import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// ═══════════════════════════════════════════════════════════════════
//  ENDOSIM ENGINE v4  — Enhanced Realism Edition
//  Changes from v3:
//   • Layered mucosa texture with subsurface-scatter-like emissive
//   • Wet specular sheen layer with animated shimmer
//   • Blood system: viscous trailing, wall-sticking pooling, drip trails
//   • Hemorrhage streaks and pooling using canvas-rendered decals
//   • Cauterize: realistic char mark + steam wisps
//   • Normal map uses haustra-correct ridge profile
//   • Polyp: dysplastic coloring + surface nodularity
//   • Stricture: fibrotic ring coloring (pale/scarred tissue)
// ═══════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────
//  ENHANCED BLOOD SYSTEM
//  Features: viscous trailing, wall-adherence, drip physics,
//            pooling decal that spreads realistically
// ────────────────────────────────────────────────────────────────
class BloodSystem {
  constructor(scene) {
    this.scene = scene
    this.particles = []
    this.trails = []       // viscous trail segments
    this.dripPaths = []    // drip streams following gravity
    this.active = false
    this.cutPoint = null
    this.cutNormal = null
    this._time = 0
    this._bloodPool = null
    this._poolRadius = 0.001
    this._hemoglobinColor = new THREE.Color(0.60, 0.00, 0.00)
    this._darkBloodColor  = new THREE.Color(0.38, 0.00, 0.00)

    // Pre-built geometry pool
    this._sphereGeo = new THREE.SphereGeometry(1, 8, 8)
    this._dripGeo   = new THREE.CylinderGeometry(0.5, 1, 1, 6)
  }

  _makeDrop(scale=1.0, pulsed=false) {
    const hue = pulsed ? 0.60 + Math.random()*0.06 : 0.50 + Math.random()*0.08
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hue, 0.0, 0.0),
      roughness: 0.90 + Math.random()*0.08,
      metalness: 0.02,
      emissive: new THREE.Color(hue*0.30, 0.0, 0.0),
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.95,
    })
    const mesh = new THREE.Mesh(this._sphereGeo, mat)
    const s = (0.006 + Math.random()*0.018) * scale
    mesh.scale.set(s, s * (1 + Math.random()*0.5), s)  // elongated drops
    return { mesh, mat }
  }

  activate(point, normal) {
    this.active = true
    this.cutPoint = point.clone()
    this.cutNormal = normal.clone()
    this._time = 0
    this._buildPool(point)
    this._buildDripStreams(point, normal)
  }

  _buildPool(point) {
    const geo = new THREE.CircleGeometry(0.001, 20)
    const mat = new THREE.MeshStandardMaterial({
      color: this._darkBloodColor,
      roughness: 0.88,
      metalness: 0.04,
      transparent: true,
      opacity: 0.0,
      emissive: new THREE.Color(0.18, 0.0, 0.0),
      emissiveIntensity: 0.4,
    })
    this._bloodPool = new THREE.Mesh(geo, mat)
    this._bloodPool.position.copy(point).addScaledVector(this.cutNormal, 0.006)
    this._bloodPool.lookAt(point)
    this.scene.add(this._bloodPool)
  }

  _buildDripStreams(point, normal) {
    // 2–3 gravity-following drip trails on the wall
    const count = 2 + Math.floor(Math.random()*2)
    for (let i=0; i<count; i++) {
      const len = 0.08 + Math.random()*0.22
      const startOffset = new THREE.Vector3(
        (Math.random()-0.5)*0.06, 0, (Math.random()-0.5)*0.06
      )
      this.dripPaths.push({
        start: point.clone().add(startOffset),
        normal: normal.clone(),
        len: 0,
        maxLen: len,
        width: 0.004 + Math.random()*0.006,
        segments: [],
        growing: true,
        life: 0,
      })
    }
  }

  deactivate() {
    this.active = false
    this.particles.forEach(p => { this.scene.remove(p.mesh); p.mat.dispose() })
    this.particles = []
    this.trails.forEach(t => { this.scene.remove(t.mesh); t.mat?.dispose() })
    this.trails = []
    this.dripPaths.forEach(d => {
      d.segments.forEach(s => { this.scene.remove(s.mesh); s.mat?.dispose() })
    })
    this.dripPaths = []
    if (this._bloodPool) { this.scene.remove(this._bloodPool); this._bloodPool.geometry.dispose(); this._bloodPool.material.dispose(); this._bloodPool = null }
  }

  update(dt) {
    if (!this.active) return
    this._time += dt

    // ── Arterial spurts — pulsed ejection rhythm ──────────────
    const heartRate = 1.2                          // ~72 bpm
    const pulse = Math.max(0, Math.sin(this._time * heartRate * Math.PI * 2))
    const spawnRate = 6 + pulse * 9                // 6–15 drops/s
    if (Math.random() < spawnRate * dt) {
      const { mesh, mat } = this._makeDrop(0.8 + pulse*0.5, pulse > 0.6)
      const spread = 0.08 + pulse * 0.06
      const vel = this.cutNormal.clone().negate()
        .addScaledVector(new THREE.Vector3(
          (Math.random()-0.5)*spread,
          (Math.random()-0.5)*spread,
          (Math.random()-0.5)*spread
        ), 1.2)
        .normalize()
        .multiplyScalar(0.30 + pulse * 0.55 + Math.random()*0.25)

      mesh.position.copy(this.cutPoint)
      this.scene.add(mesh)
      this.particles.push({
        mesh, mat, vel,
        life: 0, maxLife: 1.0 + Math.random()*1.6,
        gravity: -0.22 - Math.random()*0.12,
        viscosity: 0.85 + Math.random()*0.12,  // drag
        stuck: false, stuckTimer: 0,
        trailing: [],
      })
    }

    // ── Particle update ───────────────────────────────────────
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.life += dt

      if (p.life > p.maxLife) {
        this.scene.remove(p.mesh); p.mat.dispose()
        p.trailing.forEach(t => { this.scene.remove(t); t.geometry?.dispose(); t.material?.dispose() })
        this.particles.splice(i, 1)
        continue
      }

      if (!p.stuck) {
        // Viscous drag + gravity
        p.vel.y += p.gravity * dt
        p.vel.multiplyScalar(p.viscosity)
        const prev = p.mesh.position.clone()
        p.mesh.position.addScaledVector(p.vel, dt)

        // Wall-stick test — if moving very slowly, stick
        if (p.vel.length() < 0.06 && p.life > 0.3) {
          p.stuck = true
        }

        // Leave a trail segment every few ms
        if (Math.random() < 0.25) {
          const trailGeo = new THREE.SphereGeometry(p.mesh.scale.x * 0.55, 5, 5)
          const trailMat = new THREE.MeshStandardMaterial({
            color: this._darkBloodColor,
            roughness: 0.92, transparent: true, opacity: 0.65,
            emissive: new THREE.Color(0.10,0,0), emissiveIntensity: 0.3,
          })
          const trail = new THREE.Mesh(trailGeo, trailMat)
          trail.position.copy(prev)
          this.scene.add(trail)
          p.trailing.push(trail)
          this.trails.push({ mesh: trail, mat: trailMat, life: 0, maxLife: 3.5 })
        }

        // Fade near end of life
        const alpha = 1.0 - Math.max(0, (p.life - p.maxLife*0.65) / (p.maxLife*0.35))
        p.mat.opacity = 0.95 * alpha

      } else {
        // Stuck drip — slowly slide down
        p.stuckTimer += dt
        p.mesh.position.y -= 0.003 * dt
        p.mat.opacity = Math.max(0, 1.0 - (p.life / p.maxLife))
      }
    }

    // ── Trail fade ─────────────────────────────────────────────
    for (let i=this.trails.length-1; i>=0; i--) {
      const t=this.trails[i]
      t.life+=dt
      t.mat.opacity = Math.max(0, 0.65*(1-t.life/t.maxLife))
      if(t.life>t.maxLife){ this.scene.remove(t.mesh); t.mesh.geometry.dispose(); t.mat.dispose(); this.trails.splice(i,1) }
    }

    // ── Drip streams ──────────────────────────────────────────
    for (const drip of this.dripPaths) {
      drip.life += dt
      if (drip.growing && drip.len < drip.maxLen) {
        drip.len += dt * 0.045
        // Build a capsule segment at the drip tip
        const tipPos = drip.start.clone()
          .addScaledVector(new THREE.Vector3(0,-1,0), drip.len)  // gravity direction
        if (drip.segments.length === 0 || drip.len - drip.segments.length*0.015 > 0.015) {
          const sGeo = new THREE.SphereGeometry(drip.width, 6, 6)
          const sMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(0.45+Math.random()*0.05, 0, 0),
            roughness: 0.88, metalness: 0.02, transparent: true, opacity: 0.88,
            emissive: new THREE.Color(0.12,0,0), emissiveIntensity: 0.5,
          })
          const sMesh = new THREE.Mesh(sGeo, sMat)
          sMesh.position.copy(tipPos)
          this.scene.add(sMesh)
          drip.segments.push({ mesh: sMesh, mat: sMat })
        }
      }
    }

    // ── Pooling blood — grows realistically ───────────────────
    if (this._bloodPool) {
      const targetOpacity = Math.min(0.90, this._time * 0.35)
      this._bloodPool.material.opacity += (targetOpacity - this._bloodPool.material.opacity) * 0.04
      this._poolRadius = Math.min(0.22, 0.001 + this._time * 0.008)
      this._bloodPool.scale.setScalar(this._poolRadius)

      // Make it slightly irregular over time using scale x/z
      this._bloodPool.scale.x = this._poolRadius * (1 + Math.sin(this._time*0.4)*0.12)
      this._bloodPool.scale.z = this._poolRadius * (1 + Math.cos(this._time*0.6)*0.08)
    }
  }

  dispose() {
    this.deactivate()
    this._sphereGeo.dispose()
    this._dripGeo.dispose()
  }
}

// ────────────────────────────────────────────────────────────────
//  ENHANCED CAUTERIZE EFFECT
//  Adds: steam wisps, char gradation, spark burst
// ────────────────────────────────────────────────────────────────
class CauterizeEffect {
  constructor(scene) {
    this.scene = scene
    this.effects = []
  }

  fire(point, normal) {
    // Laser beam — expanding torus rings
    const rings = []
    for (let r = 0; r < 4; r++) {
      const geo = new THREE.TorusGeometry(0.001, 0.0025, 8, 36)
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.15, 1.0, 0.35),
        emissive: new THREE.Color(0.08, 0.85, 0.20),
        emissiveIntensity: 3.5,
        transparent: true, opacity: 0.98,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.copy(point).addScaledVector(normal, 0.018)
      mesh.lookAt(point)
      this.scene.add(mesh)
      rings.push({ mesh, delay: r * 0.07, mat })
    }

    // Char spot — dark necrotic tissue with gradient
    const charGeo = new THREE.CircleGeometry(0.045, 20)
    const charMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.05, 0.015, 0.01),
      roughness: 0.99,
      emissive: new THREE.Color(0.22, 0.07, 0.0),
      emissiveIntensity: 0.6,
      transparent: true, opacity: 0.0,
    })
    const char = new THREE.Mesh(charGeo, charMat)
    char.position.copy(point).addScaledVector(normal, 0.007)
    char.lookAt(point)
    this.scene.add(char)

    // Peripheral erythema ring (red rim around char)
    const rimGeo = new THREE.RingGeometry(0.045, 0.075, 20)
    const rimMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.65, 0.05, 0.02),
      roughness: 0.85,
      transparent: true, opacity: 0.0,
      emissive: new THREE.Color(0.30, 0.02, 0.0), emissiveIntensity: 0.5,
    })
    const rim = new THREE.Mesh(rimGeo, rimMat)
    rim.position.copy(point).addScaledVector(normal, 0.006)
    rim.lookAt(point)
    this.scene.add(rim)

    // Steam wisps — small rising particles
    const steam = []
    for (let s=0; s<8; s++) {
      const sGeo = new THREE.SphereGeometry(0.005+Math.random()*0.006, 5, 5)
      const sMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.85,0.85,0.85),
        transparent: true, opacity: 0.0,
        emissive: new THREE.Color(0.2,0.2,0.2), emissiveIntensity: 0.3,
      })
      const sMesh = new THREE.Mesh(sGeo, sMat)
      sMesh.position.copy(point).addScaledVector(normal, 0.01)
      this.scene.add(sMesh)
      steam.push({
        mesh: sMesh, mat: sMat,
        vel: new THREE.Vector3(
          (Math.random()-0.5)*0.05,
          0.04+Math.random()*0.08,
          (Math.random()-0.5)*0.05
        ),
        delay: Math.random()*0.15, life: 0, maxLife: 0.8+Math.random()*0.5
      })
    }

    // Spark burst particles
    const sparks = []
    for (let k=0; k<14; k++) {
      const sparkGeo = new THREE.SphereGeometry(0.002, 4, 4)
      const sparkMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(1.0, 0.85, 0.2),
        emissive: new THREE.Color(1.0, 0.7, 0.1), emissiveIntensity: 5,
        transparent: true, opacity: 0.95,
      })
      const sparkMesh = new THREE.Mesh(sparkGeo, sparkMat)
      sparkMesh.position.copy(point)
      this.scene.add(sparkMesh)
      sparks.push({
        mesh: sparkMesh, mat: sparkMat,
        vel: new THREE.Vector3(
          (Math.random()-0.5)*0.6,
          (Math.random()-0.5)*0.6,
          (Math.random()-0.5)*0.6
        ).normalize().multiplyScalar(0.3+Math.random()*0.8),
        life: 0, maxLife: 0.15+Math.random()*0.25,
      })
    }

    // Light flash
    const light = new THREE.PointLight(0x44ff88, 0, 1.0)
    light.position.copy(point)
    this.scene.add(light)

    this.effects.push({ rings, char, charMat, rim, rimMat, light, steam, sparks, time: 0, done: false })
  }

  update(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i]
      e.time += dt
      const t = e.time

      // Laser flash
      e.light.intensity = t < 0.12 ? (t/0.12)*7.0 : Math.max(0, 7.0-(t-0.12)/0.18*7.0)

      // Rings expand
      e.rings.forEach((rd, ri) => {
        const rt = Math.max(0, t - rd.delay)
        if (rt > 0) {
          rd.mesh.scale.setScalar(1 + rt * 220)
          rd.mat.opacity = Math.max(0, 0.98 - rt * 3.0)
          rd.mat.emissiveIntensity = Math.max(0, 3.5 - rt * 10)
        }
      })

      // Char + rim fade in
      e.charMat.opacity = Math.min(0.88, t * 5.0)
      e.rimMat.opacity  = Math.min(0.65, t * 4.0)

      // Steam wisps
      for (const s of e.steam) {
        const st = Math.max(0, t - s.delay)
        if (st > 0) {
          s.mesh.position.addScaledVector(s.vel, dt)
          s.vel.multiplyScalar(0.96)
          const phase = st / s.maxLife
          s.mat.opacity = phase < 0.3 ? phase/0.3*0.40 : Math.max(0, 0.40*(1-(phase-0.3)/0.7))
          s.mesh.scale.setScalar(1 + st * 3)
        }
      }

      // Sparks
      for (const sp of e.sparks) {
        sp.life += dt
        sp.vel.y -= 0.8 * dt
        sp.mesh.position.addScaledVector(sp.vel, dt)
        sp.mat.opacity = Math.max(0, 0.95*(1-sp.life/sp.maxLife))
        sp.mat.emissiveIntensity = Math.max(0, 5*(1-sp.life/sp.maxLife))
      }

      // Cleanup rings
      if (t > 0.55 && !e.ringsRemoved) {
        e.rings.forEach(rd => { this.scene.remove(rd.mesh); rd.mesh.geometry.dispose(); rd.mat.dispose() })
        e.rings.length = 0
        e.ringsRemoved = true
        this.scene.remove(e.light)
      }

      // Cleanup sparks
      if (t > 0.5 && !e.sparksRemoved) {
        e.sparks.forEach(sp => { this.scene.remove(sp.mesh); sp.mesh.geometry.dispose(); sp.mat.dispose() })
        e.sparks.length = 0
        e.sparksRemoved = true
      }

      // Cleanup steam
      if (t > 1.2 && !e.steamRemoved) {
        e.steam.forEach(s => { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mat.dispose() })
        e.steam.length = 0
        e.steamRemoved = true
      }

      // Char + rim fade out after 4s
      if (t > 3.8) {
        const fade = Math.max(0, 1-(t-3.8)/1.8)
        e.charMat.opacity = 0.88*fade
        e.rimMat.opacity  = 0.65*fade
      }
      if (t > 5.6) {
        this.scene.remove(e.char); e.char.geometry.dispose(); e.charMat.dispose()
        this.scene.remove(e.rim);  e.rim.geometry.dispose();  e.rimMat.dispose()
        e.done = true
      }
    }
    this.effects = this.effects.filter(e => !e.done)
  }

  dispose() {
    this.effects.forEach(e => {
      e.rings.forEach(r => { this.scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mat.dispose() })
      this.scene.remove(e.char); e.char.geometry.dispose(); e.charMat.dispose()
      this.scene.remove(e.rim);  e.rim.geometry.dispose();  e.rimMat.dispose()
      e.steam.forEach(s => { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mat.dispose() })
      e.sparks.forEach(sp=>{ this.scene.remove(sp.mesh); sp.mesh.geometry.dispose(); sp.mat.dispose() })
      this.scene.remove(e.light)
    })
    this.effects = []
  }
}

// ────────────────────────────────────────────────────────────────
//  MAIN ENGINE CLASS  (same public API as v3)
// ────────────────────────────────────────────────────────────────
export class EndoEngine {
  constructor(canvas) {
    this.canvas = canvas
    this.keys   = {}
    this.locked = false

    // Free-camera state
    this._camPos  = new THREE.Vector3(27.8303, 5.19774, 2.90591)
    this.yaw      = -Math.PI / 2   // face -X axis (standard FPS: yaw=0 faces -Z)
    this.pitch    = 0
    this._bobTime = 0
    this._moving  = false

    // Depth = how far we have travelled in -X from start
    this._startX  = 27.8303
    this._depth   = 0

    // Model
    this._modelGroup    = null
    this._damagedMeshes = []
    this._healedMeshes  = new Set()
    this._modelLoaded   = false
    this._resetPos      = null   // set after GLB loads
    this._modelScale    = 30     // default, overwritten after load

    this.onLoadCallback   = null
    this._currentScenario = 'healthy'
    this._currentMode     = 'diagnostic'

    this._overlayCanvas = null
    this._overlayCtx    = null
    this._raycaster     = new THREE.Raycaster()

    this._emergencyActive = false
    this._emergencyTimer  = 0
    this._cutMesh    = null
    this._periMesh   = null
    this._bloodSystem = null
    this._cauterize   = null
    this._emergencyFlash = 0

    // Infinite loop fade state
    this._loopFade    = 0      // 0 = transparent, 1 = black full
    this._loopFading  = false  // true while fading to black
    this._modelBounds = null   // Box3, set after load

    this._initRenderer()
    this._initScene()
    this._initLights()
    this._bindEvents()
    this.resize()
    this._loadModel()
  }

  _initRenderer() {
    this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,alpha:false})
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,2))
    this.renderer.setClearColor(0x000000)
    this.renderer.outputEncoding=THREE.sRGBEncoding
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure=1.75
  }

  _initScene() {
    this.scene  = new THREE.Scene()
    this.scene.fog = new THREE.FogExp2(0x050208, 0.04)
    // Far plane large enough for the real model scale
    this.camera = new THREE.PerspectiveCamera(82, 1, 0.01, 500)
  }

  _initLights() {
    // Primary endoscope spot — slightly warmer
    this.endoLight=new THREE.SpotLight(0xfff5e8,9.0,3.8,Math.PI*0.42,0.50,2.0)
    this.scene.add(this.endoLight); this.scene.add(this.endoLight.target)

    // Warm backfill
    this.fillLight=new THREE.PointLight(0xff3800,1.5,2.2)
    this.scene.add(this.fillLight)

    // Orbiting rim lights — asymmetric for realism
    this.rimA=new THREE.PointLight(0xff8040,0.70,1.4)
    this.rimB=new THREE.PointLight(0xff6028,0.55,1.2)
    this.scene.add(this.rimA); this.scene.add(this.rimB)

    // Tissue ambient
    this.scene.add(new THREE.AmbientLight(0x280505,2.2))

    // Emergency blood-red fill
    this.emergencyLight=new THREE.PointLight(0xff0000,0.0,3.5)
    this.scene.add(this.emergencyLight)
  }

  _ensureOverlay() {
    if (this._overlayCanvas) return
    const p=this.canvas.parentElement; if(!p) return
    if(getComputedStyle(p).position==='static') p.style.position='relative'
    this._overlayCanvas=document.createElement('canvas')
    this._overlayCtx=this._overlayCanvas.getContext('2d')
    this._overlayCanvas.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;'
    p.appendChild(this._overlayCanvas)
    this._overlayCanvas.width=p.clientWidth; this._overlayCanvas.height=p.clientHeight
  }

  _drawOverlay(alpha, mode) {
    this._ensureOverlay()
    const ctx=this._overlayCtx
    const w=this._overlayCanvas.width, h=this._overlayCanvas.height
    ctx.clearRect(0,0,w,h)
    if (alpha>0.001) {
      if (mode==='emergency') {
        ctx.fillStyle=`rgba(180,0,0,${(alpha*0.72).toFixed(3)})`
        ctx.fillRect(0,0,w,h)
        if(alpha>0.90){
          ctx.fillStyle=`rgba(255,255,255,0.92)`
          ctx.font=`bold ${Math.round(h*0.038)}px monospace`
          ctx.textAlign='center'
          ctx.fillText('⚠ PERFORATION DETECTED — EMERGENCY PROTOCOL',w/2,h/2)
          ctx.font=`${Math.round(h*0.024)}px monospace`
          ctx.fillStyle='rgba(255,200,200,0.85)'
          ctx.fillText('ACTIVATE HAEMOSTASIS — USE THERAPEUTIC MODE TO TREAT',w/2,h/2+h*0.055)
        }
      } else {
        ctx.fillStyle=`rgba(255,240,230,${alpha.toFixed(3)})`
        ctx.fillRect(0,0,w,h)
        if(alpha>0.95){
          ctx.fillStyle='rgba(80,20,10,0.85)'
          ctx.font=`bold ${Math.round(h*0.04)}px monospace`
          ctx.textAlign='center'
          ctx.fillText('RETURNING TO ENTRANCE...',w/2,h/2)
        }
      }
    }
  }

  _drawLaserCursor(x, y, w, h, hovering) {
    this._ensureOverlay()
    const ctx=this._overlayCtx
    const col = hovering ? 'rgba(80,255,100,0.96)' : 'rgba(80,255,100,0.48)'
    const sz = hovering ? 22 : 14
    ctx.strokeStyle=col; ctx.lineWidth=hovering?1.8:1.0
    ctx.beginPath(); ctx.moveTo(x-sz,y); ctx.lineTo(x+sz,y); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x,y-sz); ctx.lineTo(x,y+sz); ctx.stroke()
    ctx.beginPath(); ctx.arc(x,y,hovering?13:8,0,Math.PI*2)
    ctx.strokeStyle=col; ctx.stroke()
    if(hovering){
      ctx.fillStyle='rgba(80,255,100,0.10)'; ctx.fill()
      ctx.fillStyle='rgba(80,255,100,0.92)'
      ctx.font='bold 11px monospace'; ctx.textAlign='center'
      ctx.fillText('CLICK TO CAUTERIZE',x,y-22)
    }
  }

  // ── GLB model loader ──────────────────────────────────────────
  _loadModel() {
    const loader = new GLTFLoader()
    // Place monitors.glb in your /public folder
    loader.load(
      '/monitors.glb',
      (gltf) => {
        this._modelGroup = gltf.scene
        this.scene.add(this._modelGroup)

        // ── Compute bounding box to place camera inside the model ──
        const box = new THREE.Box3().setFromObject(this._modelGroup)
        const center = box.getCenter(new THREE.Vector3())
        const size   = box.getSize(new THREE.Vector3())

        // Log to console so you can see exact model bounds
        console.log('[EndoSim] Model bounds:', {
          min:    box.min,
          max:    box.max,
          center: center,
          size:   size,
        })

        // Start at the +X end of the model, centered on Y and Z,
        // slightly inset so we are inside the tube wall
        const startX = box.max.x - size.x * 0.05
        this._camPos.set(startX, center.y, center.z)
        this._startX = startX
        this._depth  = 0

        // Face into the tunnel (-X direction)
        this.yaw   = -Math.PI / 2
        this.pitch = 0

        // Also update _buildScenario reset point
        this._resetPos = this._camPos.clone()

        // Tune far clip to model scale
        const diag = box.min.distanceTo(box.max)
        this.camera.far = diag * 3
        this.camera.updateProjectionMatrix()

        // Tune fog density to model scale
        this.scene.fog.density = 1.5 / diag

        // Tune movement speed to model scale (store for tick)
        this._modelScale = size.x   // main travel axis length

        // Collect therapeutic targets
        this._modelGroup.traverse(obj => {
          if (obj.isMesh && (
            obj.userData.isDamaged ||
            /polyp|lesion|bleed|spot/i.test(obj.name)
          )) {
            this._damagedMeshes.push(obj)
          }
        })

        this._modelBounds = box
        this._modelLoaded = true
        this.onLoadCallback?.()
      },
      undefined,
      (err) => {
        console.error('GLB load error:', err)
        // Still fire callback so UI doesnt hang on loading screen
        this.onLoadCallback?.()
      }
    )
  }

  _buildScenario(scenarioId) {
    // With a static GLB the model doesnt change per scenario —
    // only sensor thresholds and blood/emergency effects change
    this._currentScenario = scenarioId
    this._healedMeshes.clear()
    this._stopEmergency()
    // Reset camera to the start position computed at load time
    if (this._resetPos) this._camPos.copy(this._resetPos)
    this.yaw   = -Math.PI / 2
    this.pitch = 0
    this._depth = 0
    if (this._currentMode === 'emergency') this._triggerEmergency()
  }

  _triggerEmergency() {
    if(this._emergencyActive) return
    this._emergencyActive=true; this._emergencyTimer=0
    // Place the cut 2 units ahead of camera in the -X travel direction
    const pt      = this._camPos.clone().add(new THREE.Vector3(-2, 0, 0))
    const tan     = new THREE.Vector3(-1, 0, 0)
    const up      = new THREE.Vector3(0, 1, 0)
    const right   = new THREE.Vector3().crossVectors(tan, up).normalize()
    const wallPos = pt.clone().addScaledVector(right, 0.5)

    // ENHANCED: jagged cut with more geometry points
    const cutGeo=new THREE.PlaneGeometry(0.26,0.12,6,6)
    const pos=cutGeo.attributes.position
    for(let i=0;i<pos.count;i++){
      pos.setX(i,pos.getX(i)+(Math.random()-0.5)*0.038)
      pos.setY(i,pos.getY(i)+(Math.random()-0.5)*0.020)
    }
    pos.needsUpdate=true; cutGeo.computeVertexNormals()
    const cutMat=new THREE.MeshStandardMaterial({
      color:new THREE.Color(0.68,0.0,0.0), roughness:0.86,
      emissive:new THREE.Color(0.40,0.0,0.0), emissiveIntensity:1.8,
      transparent:true, opacity:0.96, side:THREE.DoubleSide,
    })
    this._cutMesh=new THREE.Mesh(cutGeo,cutMat)
    this._cutMesh.position.copy(wallPos)
    this._cutMesh.lookAt(pt)
    this.scene.add(this._cutMesh)

    // Perilesional tissue discoloration ring
    const periGeo=new THREE.RingGeometry(0.12,0.24,24)
    const periMat=new THREE.MeshStandardMaterial({
      color:new THREE.Color(0.50,0.02,0.01), roughness:0.88,
      transparent:true, opacity:0.55,
      emissive:new THREE.Color(0.22,0.0,0.0), emissiveIntensity:0.7,
    })
    this._periMesh=new THREE.Mesh(periGeo,periMat)
    this._periMesh.position.copy(wallPos).addScaledVector(right,0.008)
    this._periMesh.lookAt(pt)
    this.scene.add(this._periMesh)

    this._bloodSystem=new BloodSystem(this.scene)
    this._bloodSystem.activate(wallPos, right.clone())
    this._cauterize=new CauterizeEffect(this.scene)
    this._emergencyFlash=1.0
  }

  _stopEmergency() {
    this._emergencyActive=false; this._emergencyTimer=0
    if(this._cutMesh){ this.scene.remove(this._cutMesh); this._cutMesh.geometry.dispose(); this._cutMesh.material.dispose(); this._cutMesh=null }
    if(this._periMesh){ this.scene.remove(this._periMesh); this._periMesh.geometry.dispose(); this._periMesh.material.dispose(); this._periMesh=null }
    this._bloodSystem?.dispose(); this._bloodSystem=null
    this._cauterize?.dispose(); this._cauterize=null
    this._emergencyFlash=0
  }

  buildTunnel(scenarioId){ this._buildScenario(scenarioId) }

  setMode(mode) {
    this._currentMode = mode
    if (mode === 'emergency' && !this._emergencyActive) this._triggerEmergency()
    if (mode !== 'emergency') this._stopEmergency()
  }

  setIlluminance(pct) {
    this.endoLight.intensity = 1.5 + (pct / 100) * 9.5
  }

  resize(){
    const p=this.canvas.parentElement; if(!p) return
    const w=p.clientWidth,h=p.clientHeight
    this.renderer.setSize(w,h,false)
    this.camera.aspect=w/h; this.camera.updateProjectionMatrix()
    if(this._overlayCanvas){ this._overlayCanvas.width=w; this._overlayCanvas.height=h }
  }

  tick(dt, mode) {
    if (this._currentMode !== mode) this.setMode(mode)

    if (!this._modelLoaded) {
      this.renderer.render(this.scene, this.camera)
      return 0
    }

    // Speed scales with model size
    const baseScale = this._modelScale ?? 30
    const spdMult   = baseScale / 30
    const spd = (mode === 'emergency' ? 5.5 : mode === 'therapeutic' ? 3.0 : 2.5) * spdMult

    // ── Emergency overlay ────────────────────────────────────────
    if (this._emergencyFlash > 0) {
      this._emergencyFlash -= dt * 1.2
      this._drawOverlay(Math.max(0, this._emergencyFlash), 'emergency')
    }
    // Note: normal overlay clearing is handled by the loop-fade block later

    // ── Build camera orientation from yaw/pitch (Euler FPS style) ─
    // yaw   = rotation around world Y (left/right)
    // pitch = rotation around local X (up/down), clamped
    this.pitch = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, this.pitch))
    // yaw is unbounded — full 360° rotation allowed

    const qYaw   = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), this.yaw)
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), this.pitch)
    const camQuat = qYaw.clone().multiply(qPitch)

    // Derive forward and right vectors from camera orientation
    const fwd   = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuat)  // -Z in cam space
    const right = new THREE.Vector3(1, 0,  0).applyQuaternion(camQuat)  // +X in cam space

    // ── Keyboard input — moves along camera facing direction ──────
    this._moving = false
    if (this.keys['KeyW'] || this.keys['ArrowUp']) {
      this._camPos.addScaledVector(fwd,   spd * dt); this._moving = true
    }
    if (this.keys['KeyS'] || this.keys['ArrowDown']) {
      this._camPos.addScaledVector(fwd,  -spd * dt); this._moving = true
    }
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) {
      this._camPos.addScaledVector(right, -spd * 0.6 * dt); this._moving = true
    }
    if (this.keys['KeyD'] || this.keys['ArrowRight']) {
      this._camPos.addScaledVector(right,  spd * 0.6 * dt); this._moving = true
    }

    // Gamepad
    const gp = navigator.getGamepads?.()[0]
    if (gp) {
      const ly = Math.abs(gp.axes[1]) > 0.12 ? gp.axes[1] : 0
      const rx = Math.abs(gp.axes[2]) > 0.12 ? gp.axes[2] : 0
      const ry = Math.abs(gp.axes[3]) > 0.12 ? gp.axes[3] : 0
      if (ly) { this._camPos.addScaledVector(fwd, -ly * spd * dt); this._moving = true }
      this.yaw   -= rx * 0.045
      this.pitch -= ry * 0.035
    }

    // ── Infinity loop — fade to black, teleport, fade back in ───
    const FADE_SPD = 2.5       // how fast fade goes (alpha/sec)
    const INSET    = 0.5       // units inside boundary before triggering

    if (this._modelBounds) {
      const minX = this._modelBounds.min.x
      const maxX = this._modelBounds.max.x

      if (!this._loopFading) {
        // Trigger fade when camera crosses either X boundary
        if (this._camPos.x < minX + INSET || this._camPos.x > maxX - INSET) {
          this._loopFading = true
        }
      }

      if (this._loopFading) {
        this._loopFade += dt * FADE_SPD

        if (this._loopFade >= 1.0) {
          // Fully black — teleport back to start, flip facing direction
          this._loopFade = 1.0
          if (this._camPos.x < minX + INSET) {
            // Reached the -X end → jump back to +X start
            this._camPos.copy(this._resetPos)
          } else {
            // Reached the +X end (retreated too far) → jump to -X end
            const endX = minX + INSET * 2
            this._camPos.set(endX, this._resetPos.y, this._resetPos.z)
          }
          this._depth = 0
          // Start fading back in
          this._loopFading = false
          this._loopFade   = 1.0   // will count down in next branch
        }
      } else if (this._loopFade > 0) {
        // Fading back in after teleport
        this._loopFade -= dt * FADE_SPD
        if (this._loopFade < 0) this._loopFade = 0
      }
    }

    // Depth = distance travelled from start in -X
    this._depth = Math.max(0, this._startX - this._camPos.x)

    // ── Head bob ─────────────────────────────────────────────────
    this._bobTime += dt * (this._moving ? 7 : 0.5)
    const bobAmt = this._moving ? 0.008 : 0

    // ── Apply to camera ──────────────────────────────────────────
    this.camera.position.copy(this._camPos)
    this.camera.position.y += Math.sin(this._bobTime) * bobAmt
    this.camera.quaternion.copy(camQuat)

    // ── Lights follow camera ─────────────────────────────────────
    this.endoLight.position.copy(this.camera.position)
    this.endoLight.target.position.copy(this.camera.position).addScaledVector(fwd, 5)
    this.endoLight.target.updateMatrixWorld()

    this.fillLight.position.copy(this.camera.position).addScaledVector(fwd, -1.5)

    const ra = this._bobTime * 0.3
    this.rimA.position.copy(this.camera.position)
      .add(new THREE.Vector3(0, Math.cos(ra)*0.8, Math.sin(ra)*0.8))
    this.rimB.position.copy(this.camera.position)
      .add(new THREE.Vector3(0, -Math.cos(ra)*0.8, -Math.sin(ra)*0.8))

    // Emergency pulsing light
    if (this._emergencyActive) {
      this.emergencyLight.position.copy(this._cutMesh?.position || this.camera.position)
      const heartPulse = Math.max(0, Math.sin(this._emergencyTimer * 1.2 * Math.PI * 2))
      this.emergencyLight.intensity = 1.2 + heartPulse * 1.2
      this._emergencyTimer += dt
    } else {
      this.emergencyLight.intensity = 0
    }

    // ── Subsystems ───────────────────────────────────────────────
    this._bloodSystem?.update(dt)
    this._cauterize?.update(dt)

    // ── Loop fade overlay — drawn on top of everything ────────────
    if (this._loopFade > 0) {
      this._ensureOverlay()
      const ctx = this._overlayCtx
      const w   = this._overlayCanvas.width
      const h   = this._overlayCanvas.height
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = `rgba(0,0,0,${this._loopFade.toFixed(3)})`
      ctx.fillRect(0, 0, w, h)
    } else if (this._emergencyFlash <= 0) {
      // Only clear overlay if nothing else needs it
      this._drawOverlay(0)
    }

    // ── Therapeutic raycasting ───────────────────────────────────
    if (mode === 'therapeutic' && this._mousePos) {
      this._raycaster.setFromCamera(this._mousePos, this.camera)
      const targets  = this._damagedMeshes.filter(m => !this._healedMeshes.has(m))
      const hits     = this._raycaster.intersectObjects(targets, true)
      const hovering = hits.length > 0

      const w  = this._overlayCanvas?.width  || this.canvas.clientWidth
      const h  = this._overlayCanvas?.height || this.canvas.clientHeight
      const mx = ((this._mousePos.x + 1) / 2) * w
      const my = ((-this._mousePos.y + 1) / 2) * h
      if (this._overlayCtx) this._drawLaserCursor(mx, my, w, h, hovering)
      this._hoveringHit = hovering ? hits[0] : null
    } else {
      this._hoveringHit = null
    }

    this.renderer.render(this.scene, this.camera)
    return this._depth * 100
  }
  _healMesh(mesh) {
    // Guard — already healed or mid-fade
    if(this._healedMeshes.has(mesh)) return
    this._healedMeshes.add(mesh)

    // Remove from raycaster targets IMMEDIATELY so it can't be hit again
    const idx = this._damagedMeshes.indexOf(mesh)
    if(idx !== -1) this._damagedMeshes.splice(idx, 1)

    // Clear the therapeutic hover so the cursor resets right away
    this._hoveringHit = null

    // Fire cauterize visual at the mesh world position
    const pt     = mesh.position.clone()
    const normal = pt.clone().sub(this.camera.position).normalize()
    this._cauterize?.fire(pt, normal)

    // Smooth fade-out via RAF (~600 ms)
    const mat         = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const origOpacity = mat.opacity ?? 1
    mat.transparent   = true
    let elapsed       = 0
    const DURATION    = 0.6

    const fade = () => {
      elapsed += 0.016
      const progress = Math.min(1, elapsed / DURATION)
      mat.opacity = origOpacity * (1 - progress)
      if(progress < 1) {
        requestAnimationFrame(fade)
      } else {
        mesh.visible = false
        mat.opacity  = 0
      }
    }
    requestAnimationFrame(fade)
  }

  destroy(){
    window.removeEventListener('resize', this._onResize)
    document.removeEventListener('keydown', this._onKeyDown)
    document.removeEventListener('keyup', this._onKeyUp)
    this.canvas.removeEventListener('click', this._onClick)
    this.canvas.removeEventListener('mousemove', this._onMouseMoveCanvas)
    document.removeEventListener('pointerlockchange', this._onLockChange)
    document.removeEventListener('mousemove', this._onMouseMove)
    this._stopEmergency()
    this._cauterize?.dispose()
    this._overlayCanvas?.remove()
    if (this._modelGroup) {
      this.scene.remove(this._modelGroup)
      this._modelGroup.traverse(c => {
        c.geometry?.dispose()
        if (Array.isArray(c.material)) c.material.forEach(m => m.dispose())
        else c.material?.dispose()
      })
    }
    this.renderer.dispose()
  }

  _bindEvents() {
    this._mousePos = new THREE.Vector2(0, 0)

    this._onResize   = () => this.resize()
    this._onKeyDown  = e  => {
      this.keys[e.code] = true
      // Prevent arrow keys from scrolling the page
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault()
    }
    this._onKeyUp = e => { this.keys[e.code] = false }

    this._onClick = () => {
      if (this._currentMode === 'therapeutic' && this._hoveringHit) {
        this._healMesh(this._hoveringHit.object)
        return
      }
      // Click canvas → request pointer lock for mouse-look
      this.canvas.requestPointerLock()
    }

    // Track normalised mouse pos for raycasting (therapeutic crosshair)
    this._onMouseMoveCanvas = e => {
      const rect = this.canvas.getBoundingClientRect()
      this._mousePos.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1
      this._mousePos.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1
    }

    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas
    }

    // Mouse-look: works ONLY while pointer is locked (click canvas first)
    // Yaw is unbounded (full 360°), pitch clamped in tick()
    this._onMouseMove = e => {
      if (!this.locked) return
      this.yaw   -= e.movementX * 0.0022
      this.pitch -= e.movementY * 0.0022
    }

    window.addEventListener('resize',           this._onResize)
    document.addEventListener('keydown',         this._onKeyDown)
    document.addEventListener('keyup',           this._onKeyUp)
    this.canvas.addEventListener('click',        this._onClick)
    this.canvas.addEventListener('mousemove',    this._onMouseMoveCanvas)
    document.addEventListener('pointerlockchange', this._onLockChange)
    document.addEventListener('mousemove',       this._onMouseMove)
  }
}