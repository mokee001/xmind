// Final catalog confirmed by the user on 2026-09-11.
export const WALL_TEMPLATES = [
  { id: 'template_1', label: '日常拼贴', description: '8 张照片的日常手帐拼贴', width: 2000, height: 2668, slots: 8 },
  { id: 'template_2', label: '圣诞手帐', description: '8 张照片的节日主题拼贴', width: 2000, height: 2668, slots: 8 },
  { id: 'template_3', label: '分层抠图拼贴', description: '15 张照片的分层拼贴，其中 12 张需要抠图', width: 2000, height: 2668, slots: 15 },
];

export const PET_COLLAGE_TEMPLATE = {
  id: 'denim_pet', label: '宠物牛仔拼贴',
  description: '5 张同一只宠物的照片，生成竖版牛仔布拼贴',
  width: 1800, height: 2400, slots: 5,
};

export const CURRENT_TEMPLATE_IDS = [...WALL_TEMPLATES.map(item => item.id), PET_COLLAGE_TEMPLATE.id];

export function currentTemplateId(id) {
  return CURRENT_TEMPLATE_IDS.includes(id) ? id : 'template_1';
}

export function requireCurrentWall(wall) {
  if (!CURRENT_TEMPLATE_IDS.includes(wall?.template)) {
    const error = new Error('服务端返回了已停用的模板，请重新生成');
    error.status = 410;
    throw error;
  }
  return wall;
}
