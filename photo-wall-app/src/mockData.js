export const devices = [
  {
    id: 'frame-living-room',
    name: '客厅照片墙',
    model: 'Waveshare 13.3” Spectra 6',
    online: true,
    battery: '电源在线',
    lastSeen: '刚刚',
    ip: '192.168.1.200',
  },
];

export const albums = [
  { id: 'recent', name: '最近项目', count: 326, selected: true, accent: '#C65D3B' },
  { id: 'family', name: '家庭时光', count: 184, selected: true, accent: '#D39A45' },
  { id: 'travel', name: '旅行', count: 97, selected: false, accent: '#5E7E73' },
  { id: 'favorites', name: '个人收藏', count: 48, selected: true, accent: '#8A6E84' },
];

export const people = [
  { id: 'p1', name: '妈妈', count: 86, policy: 'allow', file: 'IMG_1067.JPG', color: '#C65D3B' },
  { id: 'p2', name: '小满', count: 64, policy: 'allow', file: 'IMG_1077.JPG', color: '#D79B45' },
  { id: 'p3', name: '待确认人物', count: 31, policy: 'review', file: 'IMG_1080.JPG', color: '#65837B' },
  { id: 'p4', name: '不展示人物', count: 18, policy: 'block', file: 'IMG_1090.PNG', color: '#7B7771' },
];

export const initialMembers = [
  { id: 'm1', name: '我', detail: '所有者 · 当前账号', role: 'owner', initials: 'WH', color: '#C65D3B' },
  { id: 'm2', name: '家人', detail: '管理员 · 已加入', role: 'admin', initials: '家', color: '#5E7E73' },
  { id: 'm3', name: '奶奶', detail: '仅查看 · 已加入', role: 'viewer', initials: '奶', color: '#D39A45' },
];
