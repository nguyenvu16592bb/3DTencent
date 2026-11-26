/* exporter/fbx-binary.js — FBX Binary 7.4 writer có SKELETON + SKIN + BIND POSE
 *
 * Vì sao cần: bộ xuất FBX cũ trong save-manager chỉ ghi ASCII, chỉ có geometry —
 * không có bone, không có skin weight. Mixamo (và cả Blender) từ chối file đó.
 *
 * File này ghi đúng định dạng:
 *   header "Kaydara FBX Binary  \0\x1a\0" + u32 7400
 *   FBXHeaderExtension / GlobalSettings / Documents / Definitions
 *   Objects: Geometry (Vertices, PolygonVertexIndex, Normal, UV, Material)
 *            Model::Mesh, Model::LimbNode (bone), Deformer::Skin,
 *            SubDeformer::Cluster (Indexes/Weights/Transform/TransformLink),
 *            Pose (BindPose), Material
 *   Connections, Takes
 *   footer chuẩn FBX SDK / Blender (xem buildFooter): foot-id
 *   FA BC AB 09... + 4B 0 + padding 1..16B để version u32 nằm ở offset
 *   chia hết cho 16 + 120B 0 + magic 16B. Footer sai là nguyên nhân
 *   chính khiến Mixamo từ chối file trước đây (xem docs/MIXAMO_EXPORT_FIX.md).
 *
 * Mixamo chỉ nhận FBX 2013 trở xuống (version 7300) — các nút Mixamo
 * phải truyền opts.version = 7300. Bản rig (có skeleton + skin) và bản
 * mesh-only (prepareMixamo, để Mixamo tự auto-rig) đều được Mixamo nhận.
 *
 * ANIMATION (opts.animations = [{name, clip}] — clip là THREE.AnimationClip,
 * track trỏ tới xương theo tên): mỗi clip → 1 AnimationStack + Layer +
 * CurveNode (T/R/S) + Curve (KeyTime KTime int64 + KeyValueFloat float32).
 * Quaternion → Euler extrinsic XYZ độ (three.js 'ZYX' — getEulerOrder(0)='ZYX'); position cùng đơn vị với bone Lcl Translation.
 * Takes.Current + ActiveAnimStackName trỏ stack đầu tiên. fps mặc định 30.
 * Mixamo KHÔNG dùng file này (đã có sẵn skeleton) — file rigged + animation
 * dùng cho Blender/Unity/Unreal/studio.
 *
 * LỖI GỐC LẦN 2 (2026-11-23): mọi OBJECT ID (Geometry/Model/NodeAttribute/
 * Deformer/Cluster/Pose/Material/Video/Texture/Document) từng ghi bằng
 * pI = int32, trong khi FBX SDK yêu cầu int64 ('L') — Connections thì
 * đã dùng pL. SDK đọc ID int32 không khớp với connection int64 → không
 * nhận ra object nào → scene rỗng (FBX2glTF/FBX SDK trả về chỉ RootNode),
 * Mixamo báo "Unsupported FBX type. Please use FBX files 2013 or earlier."
 * three.js FBXLoader vẫn đọc được vì nó không phân biệt I/L. Đã sửa:
 * mọi ID object + PoseNode.Node đều dùng pL; các Version/Count/P-int
 * vẫn giữ pI như file SDK thật (Blender/Meshy). Đối chiếu:
 * file Meshy thật ghi Geometry/Model/Material [LSS], Document [LSS].
 *
 * Quy ước toạ độ: hình học được BAKE ra world tại bind pose, mọi Model geometry
 * đặt identity, TransformLink = xform * bone.matrixWorld tại bind → công thức skinning
 * chuẩn FBX cho ra đúng rest pose. xform (xoay trục dọc lên +Y, dịch đáy về y=0,
 * scale về cao ~1.8) PHẢI áp cho cả xương / TransformLink / BindPose, không chỉ
 * geometry — nếu không xương sẽ nhỏ/lệch hẳn so với mesh (xem boneWorldX bên dưới).
 */
(function () {
  'use strict';

  const FbxBinary = {};
  const MAGIC = 'Kaydara FBX Binary  \u0000\u001a\u0000';
  const FOOTER_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];
  const VERSION = 7400;
  /* SỐ VERSION FBX ↔ TÊN BẢN (suy trực tiếp từ header file):
   *   "; FBX 7.7.0 project file" + FBXVersion: 7700  (X Bot.fbx, Mixamo/Maya 2020)
   *   ⇒ 7.3 = 7300 = FBX 2013   |   7.4 = 7400 = FBX 2014
   * Mixamo upload từ chối file > 2013 ("Please use FBX files 2013 or earlier"),
   * nên các nút cho Mixamo phải truyền opts.version = 7300. */
  const VERSION_MIXAMO = 7300;
  /* Phần đuôi file chuẩn FBX SDK / Blender — ĐÃ KIỂM CHỨNG trên file
   * Meshy thật (Meshy_AI_tripo_convert_monter1_20261122_texture.fbx,
   * upload Mixamo OK, footer ở offset len-164):
   *   [foot-id 16B: FA BC AB 09 D0 C8 D4 66 B1 76 FB 83 1C F7 26 7E]
   *   [4B số 0]
   *   [1..16B padding 0 — sao cho version u32 nằm ở offset chia hết
   *    cho 16 tính từ đầu file (file Meshy: version ở footId+24,
   *    offset len-140, chia hết cho 16)]
   *   [u32 version] [120B số 0] [magic 16B]
   * LỖI CŨ (nguyên nhân chính khiến Mixamo từ chối): writer ghi
   * FOOTER_MAGIC thay cho foot-id, version ở offset cố định footer+21
   * (không căn 16), và thêm 20B pre-footer chứa footerLength không
   * khớp thực tế (footer 165B). FBX SDK đọc version từ đúng vị trí
   * 16-aligned → nhận giá trị rác/0 → "Unsupported FBX type".
   * three.js FBXLoader vẫn đọc được vì nó bỏ qua footer (dùng
   * heuristic 160+16), nên file mở được trong three.js/Blender
   * nhưng bị Mixamo (dùng FBX SDK) từ chối. */
  const FOOT_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
  function buildFooter(ver, footStart) {
    /* footStart: offset tuyệt đối của foot-id trong file cuối. */
    let pad = (16 - ((footStart + 20) % 16)) % 16;
    if (pad === 0) pad = 16;
    const foo = new Uint8Array(16 + 4 + pad + 4 + 120 + 16);
    for (let i = 0; i < 16; i++) foo[i] = FOOT_ID[i];
    new DataView(foo.buffer).setUint32(16 + 4 + pad, ver, true);
    for (let i = 0; i < 16; i++) foo[foo.length - 16 + i] = FOOTER_MAGIC[i];
    return foo;
  }
  /* CreationTimeStamp cố định theo Blender (1970-01-01 10:00:00.000):
   * FBX SDK kiểm tra bộ ba CreationTime + FileId + foot-id có khớp
   * nhau không (CRC theo timestamp — quy tắc không công khai); Blender
   * dùng tổ hợp cố định đã biết là SDK chấp nhận, và assimp dùng y hệt:
   *   FileId = 28 B3 2A EB B6 24 CC C2 BF C8 B0 2A A9 2B FC F1
   *   CreationTime = "1970-01-01 10:00:00:000"
   *   FootId = FA BC AB 09 D0 C8 D4 66 B1 76 FB 83 1C F7 26 7E
   * LỖI CŨ (nguyên nhân chính lần 2): writer dùng FileId đuôi
   * ...BF 52 BE 8B 6F A0 B5 2D (sai) thay vì ...BF C8 B0 2A A9 2B FC F1.
   * Đã chứng minh bằng bisect: chỉ thay FileId sang đuôi đúng thì
   * FBX SDK (FBX2glTF) đọc được mesh; đổi 1 byte bất kỳ trong đuôi
   * cũng làm SDK trả scene rỗng. Xem docs/MIXAMO_EXPORT_FIX.md. */
  const FIXED_TS = { year: 1970, month: 1, day: 1, hour: 10, minute: 0, second: 0, millisecond: 0 };
  /* Bản Binary mặc định 7400 (khớp file Meshy/Tripo đã có).
   * Bản ASCII ghi "FBX 7.3.0" (7300) = FBX 2013. */
  const VERSION_ASCII = 7300;

  /* ---------------- property helpers ---------------- */
  function pI(v) { return { k: 'I', v: v | 0 }; }
  function pD(v) { return { k: 'D', v: +v }; }
  function pL(v) { return { k: 'L', v: v }; }
  function pS(v) { return { k: 'S', v: String(v) }; }
  function pB(v) { return { k: 'C', v: v ? 1 : 0 }; }
  function arrD(list) { return { k: 'd', v: list }; }
  function arrF(list) { return { k: 'f', v: list }; }   /* float32 — KeyValueFloat / KeyAttrDataFloat */
  function arrL(list) { return { k: 'l', v: list }; }   /* int64 — KeyTime (KTime) */
  function arrI(list) { return { k: 'i', v: list }; }
  function arrB(list) { return { k: 'b', v: list }; }
  function pR(bytes) { return { k: 'R', v: bytes }; }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function node(name, props, children) {
    return { name: name, props: props || [], children: children || [] };
  }

  function encProp(p) {
    const out = [];
    if (p.k === 'I') { const b = new Uint8Array(5); b[0] = 0x49; new DataView(b.buffer).setInt32(1, p.v, true); out.push(b); }
    else if (p.k === 'D') { const b = new Uint8Array(9); b[0] = 0x44; new DataView(b.buffer).setFloat64(1, p.v, true); out.push(b); }
    else if (p.k === 'L') { const b = new Uint8Array(9); b[0] = 0x4C; new DataView(b.buffer).setBigInt64(1, BigInt(Math.round(p.v)), true); out.push(b); }
    else if (p.k === 'C') { out.push(new Uint8Array([0x43, p.v ? 1 : 0])); }
    else if (p.k === 'S') {
      const s = new TextEncoder().encode(p.v);
      const b = new Uint8Array(5 + s.length);
      const dv = new DataView(b.buffer);
      b[0] = 0x53; dv.setUint32(1, s.length, true); b.set(s, 5);
      out.push(b);
    } else if (p.k === 'R') {
      const data = p.v || new Uint8Array(0);
      const b = new Uint8Array(5 + data.length);
      const dv = new DataView(b.buffer);
      b[0] = 0x52; dv.setUint32(1, data.length, true); b.set(data, 5);
      out.push(b);
    } else if (p.k === 'd') {
      const a = p.v, n = a.length;
      const body = new Uint8Array(n * 8);
      const dv = new DataView(body.buffer);
      for (let i = 0; i < n; i++) dv.setFloat64(i * 8, a[i], true);
      const head = new Uint8Array(13);
      const hv = new DataView(head.buffer);
      head[0] = 0x64; hv.setUint32(1, n, true); hv.setUint32(5, 0, true); hv.setUint32(9, n * 8, true);
      out.push(head, body);
    } else if (p.k === 'f') {
      /* float32 array (0x66) — KeyValueFloat, KeyAttrDataFloat */
      const a = p.v, n = a.length;
      const body = new Uint8Array(n * 4);
      const dv = new DataView(body.buffer);
      for (let i = 0; i < n; i++) dv.setFloat32(i * 4, a[i], true);
      const head = new Uint8Array(13);
      const hv = new DataView(head.buffer);
      head[0] = 0x66; hv.setUint32(1, n, true); hv.setUint32(5, 0, true); hv.setUint32(9, n * 4, true);
      out.push(head, body);
    } else if (p.k === 'l') {
      /* int64 array (0x6c) — KeyTime: KTime, 46186158000/giây */
      const a = p.v, n = a.length;
      const body = new Uint8Array(n * 8);
      const dv = new DataView(body.buffer);
      for (let i = 0; i < n; i++) dv.setBigInt64(i * 8, BigInt(Math.round(a[i])), true);
      const head = new Uint8Array(13);
      const hv = new DataView(head.buffer);
      head[0] = 0x6c; hv.setUint32(1, n, true); hv.setUint32(5, 0, true); hv.setUint32(9, n * 8, true);
      out.push(head, body);
    } else if (p.k === 'i') {
      const a = p.v, n = a.length;
      const body = new Uint8Array(n * 4);
      const dv = new DataView(body.buffer);
      for (let i = 0; i < n; i++) dv.setInt32(i * 4, a[i] | 0, true);
      const head = new Uint8Array(13);
      const hv = new DataView(head.buffer);
      head[0] = 0x69; hv.setUint32(1, n, true); hv.setUint32(5, 0, true); hv.setUint32(9, n * 4, true);
      out.push(head, body);
    } else if (p.k === 'b') {
      const a = p.v, n = a.length;
      const body = new Uint8Array(n);
      for (let i = 0; i < n; i++) body[i] = a[i] ? 1 : 0;
      const head = new Uint8Array(13);
      const hv = new DataView(head.buffer);
      head[0] = 0x62; hv.setUint32(1, n, true); hv.setUint32(5, 0, true); hv.setUint32(9, n, true);
      out.push(head, body);
    }
    return out;
  }

  function propsBytes(props) {
    const parts = [];
    let len = 0;
    props.forEach(function (p) { encProp(p).forEach(function (b) { parts.push(b); len += b.length; }); });
    const buf = new Uint8Array(len);
    let o = 0;
    parts.forEach(function (b) { buf.set(b, o); o += b.length; });
    return buf;
  }

  function nodeSize(n) {
    const pb = propsBytes(n.props);
    let size = 13 + n.name.length + pb.length;
    let childSize = 0;
    n.children.forEach(function (c) { childSize += nodeSize(c); });
    if (n.children.length) childSize += 13;   /* null record kết thúc node (bắt buộc) */
    return size + childSize;
  }

  function writeNode(n, offset) {
    const nameBytes = new TextEncoder().encode(n.name);
    const pb = propsBytes(n.props);
    const total = nodeSize(n);
    let childSize = 0;
    n.children.forEach(function (c) { childSize += nodeSize(c); });

    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, offset + total, true);
    dv.setUint32(4, n.props.length, true);
    dv.setUint32(8, pb.length, true);
    buf[12] = nameBytes.length;
    buf.set(nameBytes, 13);
    buf.set(pb, 13 + nameBytes.length);
    let cur = 13 + nameBytes.length + pb.length;
    n.children.forEach(function (c) {
      const cb = writeNode(c, offset + cur);
      buf.set(cb, cur);
      cur += cb.length;
    });
    /* null record nếu có children */
    if (n.children.length) { /* đã zero sẵn */ }
    return buf;
  }

  /* ---------------- scene collection ---------------- */
  function collect(object3D) {
    const meshes = [], bones = [], boneIndex = {};
    object3D.updateMatrixWorld(true);
    object3D.traverse(function (o) {
      if (o.isBone) { boneIndex[o.uuid] = bones.length; bones.push(o); }
      /* BỎ mesh trang trí của bone (octahedron/joint sphere) — nếu không FBX sẽ
         chứa 20+ mesh khối tím và Mixamo/Blender hiển thị rác. */
      if (o.userData && o.userData.isBoneVisual) return;
      if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) meshes.push(o);
    });
    return { meshes: meshes, bones: bones, boneIndex: boneIndex };
  }

  function mat4ToArray(m) { return Array.prototype.slice.call(m.elements); }

  /* Mã hoá texture thành bytes để nhúng vào FBX (Video.Content).
     glTF (flipY=false) lưu ảnh top-down còn FBX đọc ảnh bottom-up → phải lật dọc,
     nếu không texture sẽ bị lộn ngược khi mở bằng Mixamo/Blender/Maya. */
  function encodeTextureToBytes(tex, slot, opts) {
    try {
      const img = (tex.userData && tex.userData.originalImage) || tex.image;
      if (!img) return null;
      const w = img.width || img.videoWidth || 0;
      const h = img.height || img.videoHeight || 0;
      if (!w || !h) return null;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      const mode = (opts && opts.texFlip) || 'auto';
      const flip = mode === 'v' || (mode === 'auto' && tex.flipY === false);
      if (flip) { cx.translate(0, h); cx.scale(1, -1); }
      cx.drawImage(img, 0, 0, w, h);
      const isNormal = /normal/i.test(slot);
      const mime = isNormal ? 'image/png' : 'image/jpeg';
      const url = c.toDataURL(mime, mime === 'image/jpeg' ? 0.92 : undefined);
      const b64 = url.split(',')[1];
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes: bytes, mime: mime, w: w, h: h, flipped: flip };
    } catch (e) { return null; }
  }

  /* Properties70 chuẩn của FBX: transform nằm Ở ĐÂY (không chỉ node con) —
     three FBXLoader đọc 'Lcl_Translation' in modelNode, Blender/Mixamo cũng vậy. */
  function modelProps(p, e, s, extra) {
    const list = [
      node('P', [pS('Lcl Translation'), pS('Lcl Translation'), pS(''), pS('A'), pD(p[0]), pD(p[1]), pD(p[2])]),
      node('P', [pS('Lcl Rotation'), pS('Lcl Rotation'), pS(''), pS('A'), pD(e[0]), pD(e[1]), pD(e[2])]),
      node('P', [pS('Lcl Scaling'), pS('Lcl Scaling'), pS(''), pS('A'), pD(s[0]), pD(s[1]), pD(s[2])]),
      /* RotationOrder = 0 (XYZ) BẮT BUỘC: writer ghi Lcl Rotation + AnimationCurve
       * theo Euler XYZ; three.js FBXLoader mặc định eulerOrder='ZYX' khi model
       * thiếu RotationOrder → track xoay lớn (Attack RightArm) lệch tới 30°.
       * XBot.fbx thật cũng ghi RotationOrder 0. SDK mặc định XYZ nên không đổi. */
      node('P', [pS('RotationOrder'), pS('enum'), pS(''), pS(''), pI(0)]),
      node('P', [pS('DefaultAttributeIndex'), pS('int'), pS('Integer'), pS(''), pI(0)]),
      node('P', [pS('InheritType'), pS('enum'), pS(''), pS(''), pI(1)])
    ];
    (extra || []).forEach(function (x) { list.push(x); });
    return node('Properties70', [], list);
  }

  /* ---------------- main write ---------------- */
  FbxBinary.write = function (object3D, opts) {
    opts = opts || {};
    /* version ghi vào header + node FBXVersion. 7300 = FBX 2013 (Mixamo yêu cầu
       "2013 or earlier"); 7400 = FBX 2014 (mặc định cũ, Mixamo từ chối). */
    const ver = (opts.version ? (opts.version | 0) : VERSION);
    let noSkeleton = !!opts.noSkeleton;   /* mesh-only → Mixamo tự auto-rig */
    if (opts.prepareMixamo && !opts.keepSkeleton) noSkeleton = true;   /* Mixamo tự auto-rig: bỏ skin/cluster */
    if (!window.THREE) throw new Error('THREE chưa sẵn sàng');
    const sc = collect(object3D);
    if (!sc.meshes.length) throw new Error('Không có mesh nào để xuất FBX');
    const skinned = noSkeleton ? [] : sc.meshes.filter(function (m) { return m.isSkinnedMesh && m.skeleton && m.skeleton.bones && m.skeleton.bones.length; });
    const hasSkin = skinned.length > 0;

    /* id cấp phát */
    let nextId = 100000;
    const id = function () { return nextId++; };

    const objects = [];
    const connections = [];
    const skinnedGeometryIds = [];

    /* --- model root --- */
    const models = [];
    const geoms = [];
    const mats = [];
    const clusters = [];
    const skinId = hasSkin ? id() : 0;
    const armatureId = id();

    /* ---- ASCII (FBX 7.4 text) — cho Mixamo / 3ds Max / Unity đọc chắc chắn -----------------
     * Build từ CÙNG cây node (roots) ở cuối hàm nên nội dung khớp bản binary 1:1.
     * Nhiều pipeline upload chỉ chấp nhận ASCII ("Unsupported FBX type" với binary lạ).
     * ------------------------------------------------------------------------------------ */
    function asciiProp(p, depth) {
      const num = function (x) {
        const v = +x;
        if (!isFinite(v)) return '0';
        const s = String(v);
        return (s.indexOf('.') >= 0 || s.indexOf('e') >= 0) ? s : s + '.0';
      };
      const esc = function (s) {
        return '"' + String(s)
          .replace(/&/g, '&amp;').replace(/\t/g, '&#009;').replace(/\r/g, '&#013;').replace(/\n/g, '&#010;')
          .replace(/\u0000/g, '')
          .replace(/;/g, '&#059;').replace(/,/g, '&#044;').replace(/"/g, '&quot;') + '"';
      };
      if (p.k === 'S') return esc(p.v);
      if (p.k === 'I' || p.k === 'L') return String(Math.round(p.v));
      if (p.k === 'C') return p.v ? 'T' : 'F';
      if (p.k === 'D' || p.k === 'F') return num(p.v);
      if (p.k === 'R') {
        /* Content nhị phân (Video.Content) ở ASCII phải là BASE64 — FBX SDK
           đọc Content ASCII dạng base64 (hex làm SDK giải mã sai: chuỗi hex
           525400 ký tự bị đọc thành 394050 byte rác = 525400×3/4). */
        const b = p.v || new Uint8Array(0);
        const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let s = '';
        for (let i = 0; i < b.length; i += 3) {
          const n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8) | (i + 2 < b.length ? b[i + 2] : 0);
          s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
        }
        return esc(s);
      }
      if (p.k === 'd' || p.k === 'f' || p.k === 'i' || p.k === 'b' || p.k === 'l') {
        const a = p.v, per = (p.k === 'd' || p.k === 'f') ? 100 : 200, lines = [];
        for (let i = 0; i < a.length; i += per) {
          const part = [];
          /* 'l' là int64 (KTime tới ~1e11) — KHÔNG dùng a[j]|0 (tràn int32) */
          for (let j = i; j < Math.min(i + per, a.length); j++) part.push((p.k === 'd' || p.k === 'f') ? num(a[j]) : (p.k === 'l' ? String(Math.round(a[j])) : String(a[j] | 0)));
          lines.push(part.join(','));
        }
        /* Định dạng array chuẩn SDK (XBot): dòng "a:" ở indent+1, các chunk
         * tiếp theo ở CỘT 0 (continuation line), "}" đóng ở đúng indent
         * của node. Ghi "}" ở cột 0 làm three.js TextParser không pop
         * được node — mọi node sau array đó bị nuốt mất. */
        const ind = new Array((depth || 0) + 1).join('\t');
        const indA = ind + '\t';
        if (!lines.length) return '*' + a.length + ' {\n' + indA + 'a: \n' + ind + '}';
        return '*' + a.length + ' {\n' + indA + 'a: ' + lines.join(',\n') + '\n' + ind + '}';
      }
      return '0';
    }
    function asciiNode(n, depth, out) {
      const ind = new Array(depth + 1).join('\t');
      /* Nối props bằng "," KHÔNG khoảng trắng (như SDK thật: "A",0,0,0) —
       * nối ", " làm three.js parseNodeSpecialProperty thay khoảng trắng
       * đầu tiên của đuôi số bằng "_" → parseFloat("_0.036") = NaN,
       * toàn bộ xương thành NaN (đã chứng minh bằng probe). */
      const props = n.props.map(function (p) { return asciiProp(p, depth); }).join(',');
      const head = ind + n.name + ':' + (props ? ' ' + props : '');
      /* Node lá KHÔNG props (References, Properties70 rỗng) phải ghi dạng
       * block rỗng "Name:  {" + "}" như SDK thật — ghi dòng trơ "Name:"
       * làm three.js TextParser hiểu nhầm là continuation line rồi crash. */
      if (!n.children.length && !props) { out.push(head + '  {\n' + ind + '}\n'); return; }
      if (!n.children.length) { out.push(head + '\n'); return; }
      out.push(head + ' {\n');
      n.children.forEach(function (c) { asciiNode(c, depth + 1, out); });
      out.push(ind + '}\n');
    }

    /* ---- Mixamo orientation (tự nhận diện trục "chiều cao") ---------------------
     * Mixamo yêu cầu nhân vật ĐỨNG THẲNG theo trục Y (pose T chuẩn) khi upload.
     * Model từ GLB Tripo/Meshy thường nằm ngang trong FBX (cao theo Z hoặc X).
     * Quy tắc: trục có kích thước dài nhất = trục dọc (chiều cao người/động vật) → đưa lên +Y;
     * nếu là X thì xoay thêm 90° để mặt hướng +Z. Chỉ bake vào vertex, node gốc giữ identity.
     * upAxis: 'keep' | 'Y' (mặc định tự nhận) | 'X' | 'Z' (ép trục nào là trục dọc).
     * -------------------------------------------------------------------------- */
    sc.meshes.forEach(function (m) { m.updateMatrixWorld(true); });
    const xform = new THREE.Matrix4();
    let srcBox = null;
    {
      const bb = new THREE.Box3();
      /* FIX (2026-11-26, Thiếu Lâm mocap): đo bbox trục dọc từ mesh SKINNED
         (thân nhân vật) khi có skeleton — prop gắn tay (gậy dài 1.8m nằm
         ngang, X dài ~2.1m) làm bbox X vượt chiều cao 1.8m, khiến auto-detect
         nhận nhầm X là trục dọc và xoay cả nhân vật 90° (nằm ngang, cao theo
         X). Không có skinned mesh (mesh-only / prop) thì dùng mọi mesh như cũ. */
      const bodyMeshes = skinned.length ? skinned : sc.meshes;
      bodyMeshes.forEach(function (m) { bb.expandByObject(m); });
      if (!bb.isEmpty()) srcBox = bb.clone();
    }
    let upAxisName = 'keep', origAxis = 1;
    if (opts.upAxis !== 'keep' && srcBox) {
      const size = srcBox.getSize(new THREE.Vector3());
      const dims = [size.x, size.y, size.z];
      let axis = 1;
      if (opts.upAxis === 'X') axis = 0; else if (opts.upAxis === 'Z') axis = 2;
      /* 'Y' hoặc không truyền = TỰ NHẬN trục dài nhất làm trục dọc (theo đúng
         comment ở đầu khối này). Trước đây nhánh này ép axis = 1 nên model
         Z-up/X-up từ GLB Tripo/Meshy được xuất ra vẫn NẰM NGANG, Mixamo
         không auto-rig được. */
      else axis = dims.indexOf(Math.max.apply(null, dims));
      origAxis = axis;
      upAxisName = 'XYZ'[axis];
      if (axis === 1) {
        xform.identity();
      } else if (axis === 2) {
        xform.makeRotationX(-Math.PI / 2);                     /* Z lên Y (+Z → +Y) */
      } else {
        /* +90° về Z: +X → +Y. Dấu cũ -90° đưa +X → -Y, nhân vật LỘN NGƯỢC
           (đầu ở y=0, chân ở y=1.8) rồi mới dịch đáy về 0. */
        xform.makeRotationZ(Math.PI / 2);
      }
      /* Dịch để đáy chạm y=0 và tâm footprint về gốc — đo SAU khi xoay
       * (nếu xoay, trục "đứng" của vật đổi chỗ nên phải dùng bbox đã biến đổi). */
      const outBox = srcBox.clone().applyMatrix4(xform);
      xform.premultiply(new THREE.Matrix4().makeTranslation(
        -(outBox.min.x + outBox.max.x) / 2, -outBox.min.y, -(outBox.min.z + outBox.max.z) / 2
      ));
    }
    /* nếu mesh vẫn quá nhỏ (GLB xuất bbox cm/mm) → scale để cao ≈ 1.8 đơn vị
     * (Mixamo auto-rig đo theo "chiều cao người" mặc định ~1.8 đơn vị).
     * Áp scale TRƯỚC phép xoay: scale đều nên không lệch hướng. */
    let unitScale = 1;
    if (srcBox && opts.autoScale !== false) {
      const size = srcBox.getSize(new THREE.Vector3());
      const h = Math.max(size.x, size.y, size.z);
      if (h > 0 && (h < 1.2 || h > 3.5)) unitScale = 1.8 / h;
    }
    xform.premultiply(new THREE.Matrix4().makeScale(unitScale, unitScale, unitScale));
    const useSkin = !noSkeleton && hasSkin;

    /* --- FIX (Mixamo): xform phải áp cho CẢ xương, không chỉ geometry ---
     * Trước đây geometry được bake bằng xform (xoay trục dọc lên +Y, dịch đáy
     * về y=0, scale về cao ~1.8) nhưng bone Lcl, Cluster TransformLink và
     * BindPose vẫn dùng matrixWorld GỐC → xương nhỏ/lệch hẳn so với mesh
     * (vd: mesh cao 1.8 nhưng Hips vẫn ở y=0.25), Mixamo/Blender skin sai
     * và auto-rig đo sai chiều cao. Tính world' = xform * bone.matrixWorld
     * cho mọi xương TRƯỚC khi ghi, rồi suy local từ world' của xương cha. */
    const boneWorldX = {};
    sc.bones.forEach(function (b) {
      boneWorldX[b.uuid] = xform.clone().multiply(b.matrixWorld);
    });
    const boneLocalX = function (b) {
      /* world' của xương cha gần nhất (không có → armature, identity) */
      let parentWorld = null;
      let walker = b.parent;
      while (walker) {
        if (walker.isBone && boneWorldX[walker.uuid]) { parentWorld = boneWorldX[walker.uuid]; break; }
        walker = walker.parent;
      }
      const local = new THREE.Matrix4();
      if (parentWorld) local.copy(parentWorld).invert().multiply(boneWorldX[b.uuid]);
      else local.copy(boneWorldX[b.uuid]);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      local.decompose(p, q, s);
      const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');   /* FBX lưu Euler extrinsic XYZ = three.js intrinsic 'ZYX' (getEulerOrder(0)='ZYX'); dùng 'XYZ' ở đây làm track xoay lớn lệch tới 30° */
      return {
        p: [p.x, p.y, p.z],
        e: [THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)],
        s: [s.x, s.y, s.z]
      };
    };
    const xformApplied = !xform.equals(new THREE.Matrix4());

    /* --- bones (Model::LimbNode) --- */
    const boneIds = {};
    sc.bones.forEach(function (b) {
      boneIds[b.uuid] = id();
    });

    /* --- geometry --- */
    const v3 = new THREE.Vector3();
    const n3 = new THREE.Vector3();
    sc.meshes.forEach(function (mesh, mi) {
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      const idx = geo.index;
      const triCount = idx ? idx.count : pos.count;
      const world = xform.clone().multiply(mesh.matrixWorld);

      /* Mesh gắn dưới xương (vd kiếm là con của RightHand): bake geometry
         vào không gian local của xương đó và nối Model vào xương, để mesh
         đi theo xương khi phát animation (Blender/Unity/FBXLoader).
         Mesh local → bone local: M = boneWorld'⁻¹ · world. Nhưng verts ở
         dưới đã bake `world` trước (để tính bbox world) nên bước đổi sang
         xương chỉ áp boneWorld'⁻¹ (xem FIX ở khối boneParent bên dưới).
         Mesh không có cha xương: như cũ. */
      let boneParent = null;
      if (!noSkeleton) {
        let walker = mesh.parent;
        while (walker) {
          if (walker.isBone && boneIds[walker.uuid] != null) { boneParent = walker; break; }
          walker = walker.parent;
        }
      }

      /* vertices baked world */
      const verts = [], norms = [], uvs = [], uvIndex2 = [], piv = [];
      const uvAttr = geo.attributes.uv;
      const nAttr = geo.attributes.normal;

      for (let i = 0; i < pos.count; i++) {
        v3.fromBufferAttribute(pos, i).applyMatrix4(world);
        verts.push(v3.x, v3.y, v3.z);
      }
      /* bbox để ghi Properties70.BoundingBox */
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < verts.length; i += 3) {
        if (verts[i] < minX) minX = verts[i]; if (verts[i] > maxX) maxX = verts[i];
        if (verts[i + 1] < minY) minY = verts[i + 1]; if (verts[i + 1] > maxY) maxY = verts[i + 1];
        if (verts[i + 2] < minZ) minZ = verts[i + 2]; if (verts[i + 2] > maxZ) maxZ = verts[i + 2];
      }
      const triList = [];
      for (let t = 0; t < triCount; t++) triList.push(idx ? idx.getX(t) : t);
      /* PolygonVertexIndex: đỉnh cuối của mỗi polygon = ~index (bitwise not) */
      for (let t = 0; t + 2 < triList.length; t += 3) {
        piv.push(triList[t], triList[t + 1], ~triList[t + 2]);
      }
      /* normals + uv theo polygon-vertex */
      const nm = new THREE.Matrix3().getNormalMatrix(world);
      for (let t = 0; t + 2 < triList.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = triList[t + k];
          if (nAttr) { n3.fromBufferAttribute(nAttr, vi).applyMatrix3(nm).normalize(); norms.push(n3.x, n3.y, n3.z); }
          if (uvAttr) uvs.push(uvAttr.getX(vi), uvAttr.getY(vi));
        }
      }
      /* UV theo PolygonVertex: Mixamo/3ds Max đọc kiểu này chắc chắn nhất
       * (file Mixamo gốc cũng ghi ByPolygonVertex + IndexToDirect với UVIndex = 0..n-1). */
      if (uvs.length) { for (let i = 0; i < triList.length; i++) uvIndex2.push(i); }
      /* Mesh gắn dưới xương: đổi vertex/normal world sang không gian local
         của xương (bbox ở trên đã tính trên vertex world nên không đổi).
         FIX (2026-11-26, Thiếu Lâm mocap): verts ở trên đã bake `world`
         (mesh local → world) nên chỉ cần boneWorld⁻¹ để về không gian xương.
         Bản cũ dùng boneWorld⁻¹·world rồi áp lên verts đã ở world → nhân
         đôi `world`: geometry prop (gậy/kiếm) lệch ~0.8m và sai hướng so
         với tay (gậy đứng dọc, lơ lửng trên tay thay vì nằm ngang trong tay). */
      if (boneParent) {
        const toBoneLocal = boneWorldX[boneParent.uuid].clone().invert();
        for (let i = 0; i < verts.length; i += 3) {
          v3.set(verts[i], verts[i + 1], verts[i + 2]).applyMatrix4(toBoneLocal);
          verts[i] = v3.x; verts[i + 1] = v3.y; verts[i + 2] = v3.z;
        }
        const nmBone = new THREE.Matrix3().getNormalMatrix(toBoneLocal);
        for (let i = 0; i < norms.length; i += 3) {
          n3.set(norms[i], norms[i + 1], norms[i + 2]).applyMatrix3(nmBone).normalize();
          norms[i] = n3.x; norms[i + 1] = n3.y; norms[i + 2] = n3.z;
        }
      }

      const gid = id();
      geoms.push(gid);
      const mid = id();
      const matName = ((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) || {}).name || ('mat_' + mi);
      mats.push({ id: mid, name: matName, color: mesh.material && mesh.material.color ? mesh.material.color : null, material: mesh.material });

      const gChildren = [
        node('Properties70', [], [
          node('P', [pS('BoundingBoxMin'), pS('Vector3D'), pS('Vector'), pS(''), pD(minX), pD(minY), pD(minZ)]),
          node('P', [pS('BoundingBoxMax'), pS('Vector3D'), pS('Vector'), pS(''), pD(maxX), pD(maxY), pD(maxZ)]),
          node('P', [pS('Primary Visibility'), pS('bool'), pS(''), pS(''), pB(true)])
        ]),
        node('Vertices', [arrD(verts)]),
        node('PolygonVertexIndex', [arrI(piv)]),
        node('GeometryVersion', [pI(124)])
      ];
      if (norms.length) {
        gChildren.push(node('LayerElementNormal', [pI(0)], [
          node('Version', [pI(101)]),
          node('Name', [pS('')]),
          node('MappingInformationType', [pS('ByPolygonVertex')]),
          node('ReferenceInformationType', [pS('Direct')]),
          node('Normals', [arrD(norms)])
        ]));
      }
      if (uvs.length) {
        gChildren.push(node('LayerElementUV', [pI(0)], [
          node('Version', [pI(101)]),
          node('Name', [pS('UVMap')]),
          node('MappingInformationType', [pS('ByPolygonVertex')]),
          node('ReferenceInformationType', [pS('IndexToDirect')]),
          node('UV', [arrD(uvs)]),
          node('UVIndex', [arrI(uvIndex2)])
        ]));
      }
      gChildren.push(node('LayerElementMaterial', [pI(0)], [
        node('Version', [pI(101)]),
        node('Name', [pS('')]),
        node('MappingInformationType', [pS('AllSame')]),
        node('ReferenceInformationType', [pS('IndexToDirect')]),
        node('Materials', [arrI([0])])
      ]));
      const layerEls = [];
      if (norms.length) layerEls.push(node('LayerElement', [], [node('Type', [pS('LayerElementNormal')]), node('TypedIndex', [pI(0)])]));
      if (uvs.length) layerEls.push(node('LayerElement', [], [node('Type', [pS('LayerElementUV')]), node('TypedIndex', [pI(0)])]));
      layerEls.push(node('LayerElement', [], [node('Type', [pS('LayerElementMaterial')]), node('TypedIndex', [pI(0)])]));
      gChildren.push(node('Layer', [pI(0)], [node('Version', [pI(100)])].concat(layerEls)));

      objects.push(node('Geometry', [pL(gid), pS('Geometry::' + (mesh.name || ('mesh_' + mi))), pS('Mesh')], gChildren));

      /* mesh model node — geometry đã bake world nên Lcl = identity;
         mesh gắn dưới xương thì geometry đã bake vào không gian xương
         nên Lcl vẫn identity nhưng Model nối vào xương đó (kiếm theo tay). */
      const meshModelId = id();
      models.push({ id: meshModelId, name: mesh.name || ('mesh_' + mi), matrixWorld: world });
      objects.push(node('Model', [pL(meshModelId), pS('Model::' + (mesh.name || ('mesh_' + mi))), pS('Mesh')], [
        node('Version', [pI(232)]),
        modelProps([0, 0, 0], [0, 0, 0], [1, 1, 1]),
        node('MultiLayer', [pI(0)]),
        node('MultiTake', [pI(0)]),
        node('Shading', [pB(true)]),
        node('Culling', [pS('CullingOff')])
      ]));
      connections.push({ type: 'OO', child: meshModelId, parent: boneParent ? boneIds[boneParent.uuid] : 0 });
      connections.push({ type: 'OO', child: gid, parent: meshModelId });
      connections.push({ type: 'OO', child: mid, parent: meshModelId });

      /* skin clusters */
      if (useSkin && mesh.isSkinnedMesh && mesh.skeleton && mesh.skeleton.bones && mesh.skeleton.bones.length) {
        skinnedGeometryIds.push(gid);
        const sw = geo.attributes.skinWeight, si = geo.attributes.skinIndex;
        if (sw && si) {
          const byBone = {};   /* boneUuid → {indexes:[], weights:[]} */
          for (let i = 0; i < pos.count; i++) {
            for (let k = 0; k < 4; k++) {
              const w = sw.getComponent ? sw.getComponent(i, k) : sw.array[i * 4 + k];
              if (!w || w <= 0.0001) continue;
              const bi = si.getComponent ? si.getComponent(i, k) : si.array[i * 4 + k];
              const bone = mesh.skeleton.bones[bi];
              if (!bone) continue;
              const key = bone.uuid;
              if (!byBone[key]) byBone[key] = { bone: bone, indexes: [], weights: [] };
              byBone[key].indexes.push(i);
              byBone[key].weights.push(+w.toFixed(6));
            }
          }
          Object.keys(byBone).forEach(function (k) {
            const rec = byBone[k];
            const cid = id();
            const link = boneWorldX[rec.bone.uuid].clone();   /* bind world ĐÃ qua xform (khớp geometry đã bake) */
            clusters.push({
              id: cid, boneId: boneIds[rec.bone.uuid] || 0, bone: rec.bone,
              indexes: rec.indexes, weights: rec.weights, transformLink: link,
              transform: new THREE.Matrix4()   /* geometry đã ở world → mesh bind = identity */
            });
            connections.push({ type: 'OO', child: cid, parent: skinId });
            connections.push({ type: 'OO', child: boneIds[rec.bone.uuid] || 0, parent: cid });
          });
        }
      }
    });

    /* --- bone models (bỏ khi noSkeleton → Mixamo tự auto-rig) --- */
    const boneNodes = [];
    if (!noSkeleton) {
      sc.bones.forEach(function (b) {
        const bid = boneIds[b.uuid];
        /* Local transform suy từ world' (đã qua xform) — KHÔNG dùng
           b.position/quaternion/scale gốc vì geometry đã bake xform. */
        const lx = boneLocalX(b);
        const pArr = lx.p, eArr = lx.e, sArr = lx.s;

        const attrId = id();
        objects.push(node('NodeAttribute', [pL(attrId), pS('NodeAttribute::' + b.name), pS('LimbNode')], [
          node('TypeFlags', [pS('Skeleton')])
        ]));
        objects.push(node('Model', [pL(bid), pS('Model::' + b.name), pS('LimbNode')], [
          node('Version', [pI(232)]),
          modelProps(pArr, eArr, sArr)
        ]));
        connections.push({ type: 'OO', child: attrId, parent: bid });

        /* parent: bone gần nhất là bone, ngược lại armature */
        let parentId = armatureId;
        let walker = b.parent;
        while (walker) {
          if (walker.isBone && boneIds[walker.uuid] != null) { parentId = boneIds[walker.uuid]; break; }
          walker = walker.parent;
        }
        connections.push({ type: 'OO', child: bid, parent: parentId });
        boneNodes.push(bid);
      });
    }

    /* --- armature (bỏ khi noSkeleton) --- */
    if (!noSkeleton) {
      objects.push(node('Model', [pL(armatureId), pS('Model::Armature'), pS('Null')], [
        node('Version', [pI(232)]),
        modelProps([0, 0, 0], [0, 0, 0], [1, 1, 1])
      ]));
      connections.push({ type: 'OO', child: armatureId, parent: 0 });
    }

    /* --- skin deformer (bỏ khi noSkeleton) --- */
    if (!noSkeleton && clusters.length) {
      objects.push(node('Deformer', [pL(skinId), pS('Deformer::Skin'), pS('Skin')], [
        node('Version', [pI(101)]),
        node('Link_DeformAcuracy', [pD(50)])
      ]));
      /* QUAN TRỌNG: Skin phải nối vào GEOMETRY (không phải Model).
         three FBXLoader và Blender đều tìm skin ở relationships.children của
         Geometry → nếu nối vào Model thì mesh không được skin (skinned = 0). */
      if (skinnedGeometryIds.length) {
        skinnedGeometryIds.forEach(function (gid2) {
          connections.push({ type: 'OO', child: skinId, parent: gid2 });
        });
      } else if (geoms.length) {
        connections.push({ type: 'OO', child: skinId, parent: geoms[0] });
      }

      clusters.forEach(function (c, ci) {
        objects.push(node('Deformer', [pL(c.id), pS('SubDeformer::Cluster_' + ci), pS('Cluster')], [
          node('Version', [pI(100)]),
          node('UserData', [pS(''), pS('')]),
          node('Indexes', [arrI(c.indexes)]),
          node('Weights', [arrD(c.weights)]),
          node('Transform', [arrD(mat4ToArray(c.transform))]),
          node('TransformLink', [arrD(mat4ToArray(c.transformLink))])
        ]));
      });
    }

    /* --- bind pose (bỏ khi noSkeleton) --- */
    if (!noSkeleton && sc.bones.length) {
      const poseId = id();
      const poseNodes = sc.bones.map(function (b) {
        return node('PoseNode', [], [
          node('Node', [pL(boneIds[b.uuid])]),
          node('Matrix', [arrD(mat4ToArray(boneWorldX[b.uuid]))])   /* bind world ĐÃ qua xform */
        ]);
      });
      objects.push(node('Pose', [pL(poseId), pS('Pose::BIND_POSES'), pS('BindPose')], [
        node('Type', [pS('BindPose')]),
        node('Version', [pI(100)]),
        node('NbPoseNodes', [pI(poseNodes.length)])
      ].concat(poseNodes)));
    }

    /* --- materials --- */
    mats.forEach(function (m) {
      const col = m.color ? [m.color.r, m.color.g, m.color.b] : [0.8, 0.8, 0.8];
      const mt = (Array.isArray(m.material) ? m.material[0] : m.material) || {};
      const props = [
        node('P', [pS('ShadingModel'), pS('KString'), pS(''), pS(''), pS('Phong')]),
        node('P', [pS('DiffuseColor'), pS('Color'), pS(''), pS('A'), pD(col[0]), pD(col[1]), pD(col[2])]),
        node('P', [pS('AmbientColor'), pS('Color'), pS(''), pS('A'), pD(0.2), pD(0.2), pD(0.2)]),
        node('P', [pS('EmissiveColor'), pS('Color'), pS(''), pS('A'), pD(0), pD(0), pD(0)]),
        node('P', [pS('EmissiveFactor'), pS('Number'), pS(''), pS('A'), pD(0)]),
        node('P', [pS('SpecularColor'), pS('Color'), pS(''), pS('A'), pD(1), pD(1), pD(1)]),
        node('P', [pS('SpecularFactor'), pS('Number'), pS(''), pS('A'), pD(0.25)]),
        node('P', [pS('Shininess'), pS('Number'), pS(''), pS('A'), pD(25)]),
        node('P', [pS('ShininessExponent'), pS('Number'), pS(''), pS('A'), pD(25)]),
        node('P', [pS('ReflectionColor'), pS('Color'), pS(''), pS('A'), pD(1), pD(1), pD(1)]),
        node('P', [pS('ReflectionFactor'), pS('Number'), pS(''), pS('A'), pD(0)])
      ];
      if (mt.opacity !== undefined && mt.transparent) {
        props.push(node('P', [pS('TransparencyFactor'), pS('Number'), pS(''), pS('A'), pD(1 - mt.opacity)]));
        props.push(node('P', [pS('Opacity'), pS('Number'), pS(''), pS('A'), pD(mt.opacity)]));
      }
      if (mt.map) props.push(node('P', [pS('DiffuseFactor'), pS('Number'), pS(''), pS('A'), pD(1)]));
      objects.push(node('Material', [pL(m.id), pS('Material::' + m.name), pS('')], [
        node('Version', [pI(102)]),
        node('ShadingModel', [pS('Phong')]),
        node('MultiLayer', [pI(0)]),
        node('Properties70', [], props)
      ]));
    });

    /* --- textures: nhúng ảnh (Video.Content) + Texture + connection OP ---
       Đây là phần tạo MÀU cho FBX: Mixamo/Blender chỉ thấy texture khi ảnh nằm
       trong Video.Content và Texture nối vào Material bằng OP kèm tên property. */
    const texRecords = [];
    const texReport = [];
    if (opts.embedTextures !== false) {
      const SLOTS = [
        ['map', 'DiffuseColor'],
        ['normalMap', 'NormalMap'],
        ['roughnessMap', 'ShininessExponent'],
        ['metalnessMap', 'ReflectionFactor'],
        ['aoMap', 'AmbientColor'],
        ['emissiveMap', 'EmissiveColor']
      ];
      const seen = {};
      const provided = opts.textureBytes || null;   /* {matName:{slot:{b64,mime}}} — bytes lấy sẵn từ FBX nguồn */
      mats.forEach(function (m) {
        const mt = (Array.isArray(m.material) ? m.material[0] : m.material) || {};
        SLOTS.forEach(function (s) {
          const tex = mt[s[0]];
          const pb = provided && provided[m.name] ? provided[m.name][s[0]] : null;
          if (!pb && (!tex || !tex.image)) return;
          const key = m.id + '|' + s[0] + '|' + (tex ? (tex.uuid || '') : 'provided');
          if (seen[key]) return;
          seen[key] = 1;
          let enc = null;
          if (pb && pb.b64) enc = { bytes: b64ToBytes(pb.b64), mime: pb.mime || 'image/jpeg', w: pb.w || 0, h: pb.h || 0, flipped: false };
          else enc = encodeTextureToBytes(tex, s[0], opts);
          if (!enc || !enc.bytes.length) return;
          texRecords.push({
            matId: m.id, matName: m.name, propName: s[1], slot: s[0],
            bytes: enc.bytes, mime: enc.mime, w: enc.w, h: enc.h, flipped: enc.flipped, source: pb ? 'provided' : 'canvas'
          });
        });
      });

      texRecords.forEach(function (t, i) {
        const vid = id();
        const tid = id();
        t.id = tid;
        const ext = t.mime === 'image/png' ? '.png' : '.jpg';
        const vname = (t.matName || 'tex') + '_' + t.slot + '_' + i;
        const file = 'model.fbm/' + vname + ext;
        objects.push(node('Video', [pL(vid), pS('Video::' + vname), pS('Clip')], [
          node('Type', [pS('Clip')]),
          /* Path BẮT BUỘC: FBX SDK (FbxVideo::GetFileName) đọc đường dẫn ảnh từ
             property Path này, KHÔNG phải từ node Filename — thiếu nó thì SDK
             (fbx2gltf, Mixamo) không tìm được ảnh nhúng dù Video.Content đủ
             bytes, và texture bị thay bằng ảnh 1x1 (đã chứng minh bằng bisect
             với file Meshy thật: chỉ thêm Path là fbx2gltf trích được ảnh). */
          node('Properties70', [], [
            node('P', [pS('Path'), pS('KString'), pS('Url'), pS(''), pS(file)])
          ]),
          node('UseMipMap', [pI(0)]),
          node('Filename', [pS(file)]),
          node('RelativeFilename', [pS(file)]),
          node('Content', [pR(t.bytes)])
        ]));
        objects.push(node('Texture', [pL(tid), pS('Texture::' + vname), pS('')], [
          node('Type', [pS('TextureVideoClip')]),
          node('Version', [pI(202)]),
          node('TextureName', [pS('Texture::' + vname)]),
          node('Media', [pS('Video::' + vname)]),
          node('FileName', [pS(file)]),
          node('RelativeFilename', [pS(file)]),
          node('Properties70', [], [])
        ]));
        connections.push({ type: 'OO', child: vid, parent: tid });
        connections.push({ type: 'OP', child: tid, parent: t.matId, prop: t.propName });
        texReport.push(t.matName + '.' + t.slot + ' → ' + t.propName + ' (' + t.mime + ' ' + t.w + 'x' + t.h + ', ' + Math.round(t.bytes.length / 1024) + 'KB' + (t.flipped ? ', flipped' : '') + (t.source === 'provided' ? ', from source' : '') + ')');
      });
    }

    /* ---------------- animation (opts.animations) ----------------
     * Mỗi clip [{name, clip}] (clip = THREE.AnimationClip, track trỏ tới
     * xương theo tên) → 1 AnimationStack + 1 AnimationLayer +
     * AnimationCurveNode (T/R/S cho từng xương có track) + AnimationCurve
     * (KeyTime KTime int64 + KeyValueFloat float32 + KeyAttr* chuẩn SDK).
     * Connections: stack OO→ layer OO→ curveNode OP('Lcl Translation'/
     * 'Lcl Rotation'/'Lcl Scaling' — tên đầy đủ như file XBot thật, dạng
     * rút gọn 'd|T' làm SDK không tìm được kênh) → bone model;
     * curve OP(d|X/Y/Z)→ curveNode. Takes.Current + Documents
     * ActiveAnimStackName trỏ stack đầu tiên. fps (mặc định 30) chỉ ghi
     * vào CustomFrameRate — KeyTime tính từ giây tuyệt đối nên không phụ
     * thuộc fps. Bỏ qua khi noSkeleton (không có xương để gắn track).
     * TÊN BARE (không prefix 'AnimationStack::'/'AnimCurveNode::'):
     * BinaryParser của three r128 giữ nguyên attrName (không lột prefix
     * như TextParser) nên tên có prefix làm FBXLoader không nhận ra kênh
     * T/R/S (clip ra 0 track — đã chứng minh với XBot-Mixamo.fbx).
     * Tên bare vẫn đúng chuẩn FBX (tên chỉ là nhãn, SDK nhận diện object
     * theo loại node, không theo prefix) và Blender/Unity/Unreal đọc được.
     * CHUYỂN ĐỔI: track quaternion (local TUYỆT ĐỐI, như three.js) →
     * Euler XYZ ĐỘ (FBX lưu độ, thứ tự XYZ mặc định); track position
     * cùng đơn vị với bone Lcl Translation của writer — xform là
     * similarity (scale đều + xoay + tịnh tiến) nên local của xương CÓ
     * cha xương không đổi, chỉ xương GỐC (không cha xương) mới áp xform
     * (quay + scale + tịnh tiến cho T, quay cho R, scale cho S). */
    const KT_SEC = 46186158000;   /* KTime/giây (FBXLoader: time / 46186158000) */
    const animFps = (opts.fps && isFinite(+opts.fps) && +opts.fps > 0) ? +opts.fps : 30;
    const animEntries = Array.isArray(opts.animations) ? opts.animations : [];
    const animReport = [];
    let firstStackName = '';
    let maxAnimKTime = 0;
    if (animEntries.length && !noSkeleton && sc.bones.length) {
      const xformDecomp = (function () {
        const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
        xform.decompose(p, q, s);
        return { p: p, q: q, s: s.x };
      })();
      const boneByName = {};
      sc.bones.forEach(function (b) {
        boneByName[b.name] = b;
        const short = String(b.name).replace(/^.*:/, '');
        if (!boneByName[short]) boneByName[short] = b;
      });
      const isRootBone = function (bone) {
        let w = bone.parent;
        while (w) { if (w.isBone) return false; w = w.parent; }
        return true;
      };
      animEntries.forEach(function (entry, stackIdx) {
        const clip = (entry && entry.clip) || entry;
        const stackName = String((entry && entry.name) || (clip && clip.name) || ('Take' + (stackIdx + 1)));
        if (!clip || !Array.isArray(clip.tracks) || !clip.tracks.length) return;
        /* gom track theo xương + kênh (T/R/S); trùng xương+kênh: giữ track đầu */
        const perBone = {};
        clip.tracks.forEach(function (tr) {
          if (!tr || typeof tr.name !== 'string') return;
          const dot = tr.name.lastIndexOf('.');
          if (dot < 0) return;
          const nodeName = tr.name.slice(0, dot);
          const prop = tr.name.slice(dot + 1);
          const attr = prop === 'position' ? 'T' : prop === 'quaternion' ? 'R' : prop === 'scale' ? 'S' : null;
          if (!attr) return;   /* vd morphTargetInfluences: chưa hỗ trợ */
          const bone = boneByName[nodeName] || boneByName[String(nodeName).replace(/^.*:/, '')];
          if (!bone) return;
          const times = Array.prototype.slice.call(tr.times || []);
          const values = Array.prototype.slice.call(tr.values || []);
          if (!times.length || !values.length) return;
          if (!perBone[bone.uuid]) perBone[bone.uuid] = { bone: bone, T: null, R: null, S: null };
          if (perBone[bone.uuid][attr]) return;
          const rootBone = isRootBone(bone);
          const slot = { times: times, x: [], y: [], z: [] };
          perBone[bone.uuid][attr] = slot;
          const n = times.length;
          if (attr === 'R') {
            const e = new THREE.Euler();
            const q = new THREE.Quaternion();
            for (let i = 0; i < n; i++) {
              q.set(values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]);
              if (rootBone) q.premultiply(xformDecomp.q);
              /* FBX lưu Euler extrinsic XYZ = three.js intrinsic 'ZYX'
               * (getEulerOrder(0)='ZYX'); dùng 'XYZ' làm track xoay lớn
               * (Attack RightArm) lệch tới 30° khi đọc lại. */
              e.setFromQuaternion(q, 'ZYX');
              slot.x.push(THREE.MathUtils.radToDeg(e.x));
              slot.y.push(THREE.MathUtils.radToDeg(e.y));
              slot.z.push(THREE.MathUtils.radToDeg(e.z));
            }
            /* UNWRAP Euler — sửa lỗi CHÂN BAY LÊN TRỜI (đo 2026-11-26):
             * setFromQuaternion trả góc [-180,180] nên khi chuyển động
             * xoay qua biên ±180° (Hips xoay ~360° lúc spin; local
             * UpLeg/ForeArm ~177° do R_fix), 2 key kề nhau lệch ~±350°
             * trong file (StaffSpin V2: 19 đoạn, Wushu: 19 đoạn — đo trực
             * tiếp từ KeyValueFloat). three.js FBXLoader
             * (interpolateRotations) chia đoạn ≥180° thành bước 180° và
             * Blender nội suy tuyến tính Euler đều đi đường DÀI → xương
             * lật ~180° giữa 2 key, chân bay 1,2-1,5 m (HipsErr 149-176°).
             * Clip gốc KHÔNG sai (chân trong clip 0,03-0,20 m, khớp
             * landmark) nên sửa track chân trong clip không có tác dụng.
             * Unwrap: cộng/trừ 360° để 2 key kề lệch ≤180° — cùng góc
             * quay tại mọi key (Euler lệch 360° là cùng 1 hướng), chỉ làm
             * đường nội suy đi đường NGẮN đúng. Chỉ đổi khi span >180°
             * (chuyển động thật ≤~30°/frame) nên file không có wrap thì
             * không đổi gì. */
            [slot.x, slot.y, slot.z].forEach(function (arr) {
              for (let i = 1; i < arr.length; i++) {
                let d = arr[i] - arr[i - 1];
                while (d > 180) { arr[i] -= 360; d -= 360; }
                while (d < -180) { arr[i] += 360; d += 360; }
              }
            });
          } else {
            for (let i = 0; i < n; i++) {
              let x = values[i * 3], y = values[i * 3 + 1], z = values[i * 3 + 2];
              if (rootBone) {
                if (attr === 'T') {
                  const v = new THREE.Vector3(x, y, z).multiplyScalar(xformDecomp.s).applyQuaternion(xformDecomp.q).add(xformDecomp.p);
                  x = v.x; y = v.y; z = v.z;
                } else {
                  x *= xformDecomp.s; y *= xformDecomp.s; z *= xformDecomp.s;
                }
              }
              slot.x.push(x); slot.y.push(y); slot.z.push(z);
            }
          }
        });
        const boneUuids = Object.keys(perBone).filter(function (u) {
          const rec = perBone[u];
          return !!(rec.T || rec.R || rec.S);
        });
        if (!boneUuids.length) return;
        let dur = (typeof clip.duration === 'number' && isFinite(clip.duration) && clip.duration > 0) ? clip.duration : 0;
        if (!dur) {
          boneUuids.forEach(function (u) {
            const rec = perBone[u];
            ['T', 'R', 'S'].forEach(function (a) {
              if (rec[a]) dur = Math.max(dur, rec[a].times[rec[a].times.length - 1]);
            });
          });
        }
        if (!dur) return;
        const durK = Math.round(dur * KT_SEC);
        if (durK > maxAnimKTime) maxAnimKTime = durK;
        const stackId = id();
        const layerId = id();
        if (!firstStackName) firstStackName = stackName;
        objects.push(node('AnimationStack', [pL(stackId), pS(stackName), pS('')], [
          node('Properties70', [], [
            node('P', [pS('LocalStart'), pS('KTime'), pS('Time'), pS(''), pL(0)]),
            node('P', [pS('LocalStop'), pS('KTime'), pS('Time'), pS(''), pL(durK)]),
            node('P', [pS('ReferenceStart'), pS('KTime'), pS('Time'), pS(''), pL(0)]),
            node('P', [pS('ReferenceStop'), pS('KTime'), pS('Time'), pS(''), pL(durK)])
          ])
        ]));
        objects.push(node('AnimationLayer', [pL(layerId), pS(stackName), pS('')], [
          node('Properties70', [], [
            node('P', [pS('Weight'), pS('Number'), pS(''), pS('A'), pD(100)]),
            node('P', [pS('Mute'), pS('bool'), pS(''), pS(''), pB(false)]),
            node('P', [pS('Lock'), pS('bool'), pS(''), pS(''), pB(false)])
          ])
        ]));
        connections.push({ type: 'OO', child: layerId, parent: stackId });
        let curveNodeCount = 0, curveCount = 0, trackCount = 0;
        boneUuids.forEach(function (u) {
          const rec = perBone[u];
          const bone = rec.bone;
          const lx = boneLocalX(bone);   /* giá trị mặc định d|X/Y/Z = rest local */
          ['T', 'R', 'S'].forEach(function (attr) {
            const slot = rec[attr];
            if (!slot) return;
            trackCount++;
            const cnId = id();
            const def = attr === 'T' ? lx.p : attr === 'R' ? lx.e : lx.s;
            objects.push(node('AnimationCurveNode', [pL(cnId), pS(attr), pS('')], [
              node('Properties70', [], [
                node('P', [pS('d|X'), pS('Number'), pS(''), pS('A'), pD(def[0])]),
                node('P', [pS('d|Y'), pS('Number'), pS(''), pS('A'), pD(def[1])]),
                node('P', [pS('d|Z'), pS('Number'), pS(''), pS('A'), pD(def[2])])
              ])
            ]));
            /* OP curveNode→bone dùng TÊN PROPERTY ĐẦY ĐỦ 'Lcl Translation'/
               'Lcl Rotation'/'Lcl Scaling' (như file XBot thật) — dạng rút
               gọn 'd|T'/'d|R' làm FBX SDK không tìm được kênh nào
               (fbx2gltf báo 'zero channels'). three r128 chỉ cần
               relationship khác undefined nên vẫn đọc được. */
            connections.push({ type: 'OP', child: cnId, parent: boneIds[bone.uuid], prop: attr === 'T' ? 'Lcl Translation' : attr === 'R' ? 'Lcl Rotation' : 'Lcl Scaling' });
            connections.push({ type: 'OO', child: cnId, parent: layerId });
            curveNodeCount++;
            const keyTimes = slot.times.map(function (t) { return Math.round(t * KT_SEC); });
            ['x', 'y', 'z'].forEach(function (axis) {
              const cuId = id();
              const vals = slot[axis];
              /* KeyAttrFlags 8456 = Cubic(8) | TangentAuto(256) |
                 GenericTimeIndependent(8192) — đúng file XBot thật.
                 Flags 256 (chỉ TangentAuto, không có interpolation type)
                 làm FBX SDK (fbx2gltf 0.9.7) segfault. KeyAttrRefCount = 1
                 như file thật (0 cũng làm SDK đọc sai). Default = giá trị
                 key đầu (file thật: Default ≈ giá trị key đầu). */
              const flags = vals.map(function () { return 8456; });
              const dataFloats = [];
              for (let i = 0; i < vals.length; i++) dataFloats.push(0, 0, 0, 0);
              const refCounts = vals.map(function () { return 1; });
              objects.push(node('AnimationCurve', [pL(cuId), pS(String(bone.name).replace(/[^A-Za-z0-9_]/g, '_') + '_' + attr + axis.toUpperCase()), pS('')], [
                node('Default', [pD(vals[0])]),
                node('KeyVer', [pI(4009)]),
                node('KeyTime', [arrL(keyTimes)]),
                node('KeyValueFloat', [arrF(vals)]),
                node('KeyAttrFlags', [arrI(flags)]),
                node('KeyAttrDataFloat', [arrF(dataFloats)]),
                node('KeyAttrRefCount', [arrI(refCounts)])
              ]));
              connections.push({ type: 'OP', child: cuId, parent: cnId, prop: 'd|' + axis.toUpperCase() });
              curveCount++;
            });
          });
        });
        animReport.push({ name: stackName, duration: +dur.toFixed(3), tracks: trackCount, curveNodes: curveNodeCount, curves: curveCount });
      });
    }

    /* ---------------- header sections ---------------- */
    /* CreationTimeStamp cố định 1970-01-01 10:00:00.000 như Blender
     * (xem FIXED_TS phía trên): FBX SDK kiểm tra bộ ba CreationTime +
     * FileId + foot-id, ghi thời gian hiện tại sẽ làm tổ hợp lệch. */
    const now = FIXED_TS;
    const header = node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [pI(1003)]),
      node('FBXVersion', [pI(ver)]),
      node('EncryptionType', [pI(0)]),
      node('CreationTimeStamp', [], [
        node('Version', [pI(1000)]),
        node('Year', [pI(now.year)]),
        node('Month', [pI(now.month)]),
        node('Day', [pI(now.day)]),
        node('Hour', [pI(now.hour)]),
        node('Minute', [pI(now.minute)]),
        node('Second', [pI(now.second)]),
        node('Millisecond', [pI(now.millisecond)])
      ]),
      node('Creator', [pS('PixiJS Studio x Tripo3D AI Studio v' + (window.PixiStudio && PixiStudio.VERSION || '20.0') + ' — FBX Binary Writer')]),
      node('SceneInfo', [pS('GlobalInfo\u0000\u0001SceneInfo'), pS('UserData')], [
        node('Type', [pS('UserData')]),
        node('Version', [pI(100)]),
        node('MetaData', [], [
          node('Version', [pI(100)]),
          node('Title', [pS('')]),
          node('Subject', [pS('')]),
          node('Author', [pS('PixiJS Studio')]),
          node('Keywords', [pS('')]),
          node('Revision', [pS('1.0')]),
          node('Comment', [pS('')])
        ]),
        node('Properties70', [], [])
      ])
    ]);

    const globalSettings = node('GlobalSettings', [], [
      node('Version', [pI(1000)]),
      node('Properties70', [], [
        node('P', [pS('UpAxis'), pS('int'), pS('Integer'), pS(''), pI(1)]),
        node('P', [pS('UpAxisSign'), pS('int'), pS('Integer'), pS(''), pI(1)]),
        node('P', [pS('FrontAxis'), pS('int'), pS('Integer'), pS(''), pI(2)]),
        node('P', [pS('FrontAxisSign'), pS('int'), pS('Integer'), pS(''), pI(1)]),
        node('P', [pS('CoordAxis'), pS('int'), pS('Integer'), pS(''), pI(0)]),
        node('P', [pS('CoordAxisSign'), pS('int'), pS('Integer'), pS(''), pI(1)]),
        node('P', [pS('OriginalUpAxis'), pS('int'), pS('Integer'), pS(''), pI(origAxis)]),
        node('P', [pS('OriginalUpAxisSign'), pS('int'), pS('Integer'), pS(''), pI(1)]),
        node('P', [pS('UnitScaleFactor'), pS('double'), pS('Number'), pS(''), pD(100)]),
        node('P', [pS('OriginalUnitScaleFactor'), pS('double'), pS('Number'), pS(''), pD(1)]),
        node('P', [pS('AmbientColor'), pS('ColorRGB'), pS('Color'), pS(''), pD(0), pD(0), pD(0)]),
        node('P', [pS('DefaultCamera'), pS('KString'), pS(''), pS(''), pS('Producer Perspective')]),
        node('P', [pS('TimeMode'), pS('enum'), pS(''), pS(''), pI(11)]),
        node('P', [pS('TimeSpanStart'), pS('KTime'), pS('Time'), pS(''), pL(0)]),
        node('P', [pS('TimeSpanStop'), pS('KTime'), pS('Time'), pS(''), pL(maxAnimKTime || 46186158000)]),
        node('P', [pS('CustomFrameRate'), pS('double'), pS('Number'), pS(''), pD(animReport.length ? animFps : 24)])
      ])
    ]);

    const docId = id();
    const documents = node('Documents', [], [
      node('Count', [pI(1)]),
      node('Document', [pL(docId), pS(''), pS('Scene')], [
        node('Properties70', [], [
          node('P', [pS('SourceObject'), pS('object'), pS(''), pS('')]),
          node('P', [pS('ActiveAnimStackName'), pS('KString'), pS(''), pS(''), pS(firstStackName)])
        ]),
        node('RootNode', [pL(0)])
      ])
    ]);

    /* Definitions/Count = số object trong Objects + 1 (node gốc id 0,
     * không nằm trong Objects) — khớp file Meshy thật (Count 12 =
     * 11 Objects + 1). Giá trị cũ 7 + objects.length sai.
     * Các ObjectType có count = 0 bị loại: file thật (Meshy, Blender)
     * chỉ liệt kê type đang dùng. */
    const defTypes = [
      ['GlobalSettings', 1],
      ['Model', (noSkeleton ? 0 : sc.bones.length) + models.length + (noSkeleton ? 0 : 1)],
      ['NodeAttribute', noSkeleton ? 0 : sc.bones.length],
      ['Geometry', geoms.length],
      ['Material', mats.length],
      ['Texture', texRecords.length],
      ['Video', texRecords.length],
      ['Deformer', noSkeleton ? 0 : clusters.length + (clusters.length ? 1 : 0)],
      ['Pose', noSkeleton ? 0 : (sc.bones.length ? 1 : 0)],
      ['AnimationStack', animReport.length],
      ['AnimationLayer', animReport.length],
      ['AnimationCurveNode', animReport.reduce(function (a, r) { return a + r.curveNodes; }, 0)],
      ['AnimationCurve', animReport.reduce(function (a, r) { return a + r.curves; }, 0)]
    ].filter(function (t) { return t[1] > 0; });
    const defs = node('Definitions', [], [
      node('Version', [pI(100)]),
      node('Count', [pI(objects.length + 1)])
    ].concat(defTypes.map(function (t) {
      return node('ObjectType', [pS(t[0])], [node('Count', [pI(t[1])])]);
    })));

    const connNode = node('Connections', [], connections.map(function (c) {
      const props = [pS(c.type), pL(c.child), pL(c.parent)];
      /* OP: Texture → Material kèm TÊN PROPERTY (DiffuseColor/NormalMap...).
         Thiếu tên property thì Mixamo/Blender không gắn được texture vào material → mất màu. */
      if (c.prop !== undefined) props.push(pS(c.prop));
      return node('C', props);
    }));

    const takes = node('Takes', [], [node('Current', [pS(firstStackName)])]);

    /* ---------------- assemble ---------------- */
    const roots = [header,
      node('FileId', [pR(new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]))]),
      node('CreationTime', [pS('1970-01-01 10:00:00:000')]),
      node('Creator', [pS('Blender (FBX Binary ' + (ver === 7300 ? '7.3.0' : '7.4.0') + ')')]),
      globalSettings, documents,
      node('References', [], []),
      defs, node('Objects', [], objects), connNode, takes];

    /* ---- nhánh ASCII (opts.ascii) ----
     * Header kiểu FBX 2013 ASCII: "FBXHeaderExtension + FileId + CreationTime + Creator" ở dạng text,
     * sau đó tới cây node y hệt bản binary. Dùng CÙNG roots nên nội dung khớp 1:1. */
    if (opts.ascii) {
      const vi = VERSION_ASCII;
      const lines = [];
      lines.push('; FBX 7.3.0 project file');
      lines.push('; Created by PixiJS Studio x Tripo3D AI Studio');
      lines.push('; ----------------------------------------------------');
      lines.push('');
      /* "khai báo" file/version dạng comment có chứa đủ từ khóa FBX */
      lines.push('FBXHeaderExtension:  {');
      lines.push('\tFBXHeaderVersion: 1003');
      lines.push('\tFBXVersion: ' + vi);
      lines.push('\tEncryptionType: 0');
      lines.push('\tCreationTimeStamp:  {');
      lines.push('\t\tVersion: 1000');
      lines.push('\t\tYear: ' + now.year + '\n\t\tMonth: ' + now.month + '\n\t\tDay: ' + now.day);
      lines.push('\t\tHour: ' + now.hour + '\n\t\tMinute: ' + now.minute + '\n\t\tSecond: ' + now.second + '\n\t\tMillisecond: ' + now.millisecond);
      lines.push('\t}');
      lines.push('\tCreator: "PixiJS Studio x Tripo3D AI Studio v' + (window.PixiStudio && PixiStudio.VERSION || '20.0') + '"');
      lines.push('}');
      /* GUARD — three.js r128 FBXLoader.isFbxFormatASCII là heuristic mong manh:
       * nó đọc ký tự tại các vị trí tam giác 0,1,3,6,10,15,21,28,36,45,55,66,
       * 78,91,105,120,136,153,171,190 và nếu BẤT KỲ ký tự nào trùng CORRECT
       * ('Kaydara\\FBX\\Binary\\\\') thì kết luận KHÔNG phải ASCII -> throw
       * 'THREE.FBXLoader: Unknown format'. Header ngắn đi 15 ký tự khi bỏ
       * '(Mixamo-ready)' (bản sửa Mixamo) đã làm vị trí 136 rơi đúng chữ 'r'
       * của 'FBXHeaderExtension' nên file WushuAttack V3 bị loader từ chối
       * (V2 dài hơn nên thoát — đo 2026-11-26, mô phỏng Python khớp). Đệm dấu
       * '.' vào dòng 'Created by' cho tới khi heuristic qua — đảm bảo file
       * ASCII luôn đọc được bằng FBXLoader r128 (studio dùng loader này). */
      (function () {
        const CORRECT_ASCII = ['K', 'a', 'y', 'd', 'a', 'r', 'a', '\\', 'F', 'B', 'X', '\\', 'B', 'i', 'n', 'a', 'r', 'y', '\\', '\\'];
        const SAMPLE_POS = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78, 91, 105, 120, 136, 153, 171, 190];
        for (let tries = 0; tries < 24; tries++) {
          const head = lines.join('\n').slice(0, 200);
          let bad = false;
          for (let i = 0; i < SAMPLE_POS.length; i++) {
            if (head[SAMPLE_POS[i]] === CORRECT_ASCII[i]) { bad = true; break; }
          }
          if (!bad) return;
          lines[1] += '.';
        }
      })();
      /* toàn bộ cây còn lại trừ FBXHeaderExtension (đã viết tay phía trên) và
       * FileId/CreationTime/Creator: 3 node lá này ở ASCII thành property
       * top-level ngoài mọi node, làm three.js TextParser crash (stack rỗng)
       * — file ASCII thật của SDK (XBot.fbx) cũng KHÔNG có chúng ở top-level. */
      roots.filter(function (n) { return n.name !== 'FBXHeaderExtension' && n.name !== 'FileId' && n.name !== 'CreationTime' && n.name !== 'Creator'; })
        .forEach(function (n) { asciiNode(n, 0, lines); });
      /* đuôi file ASCII: CHỈ text thuần (kết thúc bằng newline) — KHÔNG gắn
       * footer nhị phân (null record + foot-id + magic) như trước: khi đọc
       * dạng text, three.js TextParser tách cả phần nhị phân thành "dòng"
       * rồi crash ở parseNodePropertyContinued (stack rỗng). File ASCII thật
       * của SDK (XBot.fbx) cũng không có footer nhị phân. */
      const enc = new TextEncoder();
      const asc = enc.encode(lines.join('\n') + '\n');
      return {
        bytes: asc,
        report: {
          bytes: asc.length, format: 'FBX-ASCII-7.3', version: vi,
          meshes: sc.meshes.length, bones: noSkeleton ? 0 : sc.bones.length,
          clusters: noSkeleton ? 0 : clusters.length, materials: mats.length,
          geometryIds: geoms.length, hasSkin: useSkin && clusters.length > 0,
          upAxis: xformApplied ? ('baked: ' + upAxisName + ' → Y, feet at y=0') : 'kept as-is',
          srcUpAxis: upAxisName,
          version: ver, unitScale: +unitScale.toFixed(4), meshOnly: !!noSkeleton,
          animations: animReport, animationStacks: animReport.length, fps: animFps
        }
      };
    }

    const headerBytes = new TextEncoder().encode(MAGIC);
    let offset = headerBytes.length + 4;
    let bodySize = 0;
    roots.forEach(function (n) { bodySize += nodeSize(n); });
    bodySize += 13;   /* null record cuối top-level (13 byte căn chỉnh, giá trị 0) */

    const out = new Uint8Array(offset + bodySize);
    out.set(headerBytes, 0);
    new DataView(out.buffer).setUint32(headerBytes.length, ver, true);
    let pos = offset;
    roots.forEach(function (n) {
      const b = writeNode(n, pos);
      out.set(b, pos);
      pos += b.length;
    });
    pos += 13;   /* null record */
    /* --- phần đuôi file (FBX SDK trailer) ---
     * buildFooter: [foot-id FA BC AB 09... 16B] [0×4] [padding 1..16B
     * để version u32 nằm ở offset chia hết cho 16 tính từ đầu file]
     * [u32 VERSION] [0×120B] [magic 16B]. Đặt ngay sau null record,
     * KHÔNG có pre-footer 20B — xem giải thích chi tiết ở buildFooter. */
    const foo = buildFooter(ver, out.length);
    const bytes = new Uint8Array(out.length + foo.length);
    bytes.set(out, 0);
    bytes.set(foo, out.length);

    return {
      bytes: bytes,
      report: {
        bytes: bytes.length,
        format: ver === 7300 ? 'FBX-Binary-7.3' : 'FBX-Binary-7.4',
        meshes: sc.meshes.length,
        bones: noSkeleton ? 0 : sc.bones.length,
        clusters: noSkeleton ? 0 : clusters.length,
        materials: mats.length,
        geometryIds: geoms.length,
        hasSkin: noSkeleton ? false : clusters.length > 0,
        textures: texRecords.length,
        textureReport: texReport,
        upAxis: xformApplied ? ('baked: ' + upAxisName + ' → Y, feet at y=0') : 'kept as-is',
        srcUpAxis: upAxisName,
        version: ver,
        versionName: ver === 7300 ? 'FBX 2013' : (ver === 7400 ? 'FBX 2014' : 'FBX ' + ver),
        unitScale: +unitScale.toFixed(4),
        meshOnly: !!noSkeleton,
        animations: animReport,
        animationStacks: animReport.length,
        fps: animFps
      }
    };
  };

  /* ---------------- minimal reader để tự kiểm tra ---------------- */
  FbxBinary.read = function (bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 27;   /* 20 magic + 3 (00 1a 00) + 4 version */
    const nodes = [];
    const readNode = function (depth) {
      if (off + 13 > bytes.length) return null;
      const end = dv.getUint32(off, true);
      const numProps = dv.getUint32(off + 4, true);
      const propLen = dv.getUint32(off + 8, true);
      const nameLen = bytes[off + 12];
      if (end === 0 && numProps === 0 && propLen === 0 && nameLen === 0) { off += 13; return null; }
      const name = new TextDecoder().decode(bytes.subarray(off + 13, off + 13 + nameLen));
      off += 13 + nameLen + propLen;
      const children = [];
      while (off < end) {
        const c = readNode(depth + 1);
        if (!c) break;
        children.push(c);
      }
      if (off < end) off = end;
      return { name: name, children: children };
    };
    while (off < bytes.length - 16) {
      const n = readNode(0);
      if (!n) break;
      nodes.push(n);
    }
    return nodes;
  };

  /* Dùng chung cho exporter khác (OBJ+MTL ZIP cần cùng bytes ảnh, cùng quy tắc lật) */
  FbxBinary.encodeTexture = encodeTextureToBytes;

  window.PixiStudio.FBXBinary = FbxBinary;
})();