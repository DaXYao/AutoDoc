import type { ButtonProps, GlobalThemeOverrides } from 'naive-ui'

/**
 * D1 米白极简设计系统的 Naive UI 主题覆写唯一入口。
 * 语义色族（hover/pressed/supplied）与 style.css 的 :root 令牌同源，
 * 组件层不允许再单独改色，保证 naive 控件与手写样式同一套色板。
 */
export const themeOverrides: GlobalThemeOverrides = {
  common: {
    // 交互强调色：靛蓝族。基准取 #3B5BE6（白底≈5.5:1）而非 #4C6FFF：
    // naive 按钮文字多为 12-13px 白字，#4C6FFF 底仅≈4.18:1 不满足 AA 4.5:1；
    // hover 回到 #4C6FFF 保持交互强调观感，pressed 加深一档
    primaryColor: '#3B5BE6',
    // hover 取比 base 略深而非更亮：更亮的 #4C6FFF 白字仅 4.18:1 不达 AA，深色 ramp 全程达标
    primaryColorHover: '#3550D0',
    primaryColorPressed: '#2F49C0',
    primaryColorSuppl: '#EEF2FF',
    infoColor: '#3B5BE6',
    infoColorHover: '#3550D0',
    infoColorPressed: '#2F49C0',
    infoColorSuppl: '#EEF2FF',
    // 状态色降饱和族：贴合米白底的低对比暖灰环境
    successColor: '#3D9A6C',
    successColorHover: '#5CB086',
    successColorPressed: '#2F7E57',
    successColorSuppl: '#EBF5F0',
    warningColor: '#C98A2D',
    warningColorHover: '#D9A04B',
    warningColorPressed: '#A87122',
    warningColorSuppl: '#FAF3E8',
    errorColor: '#D5484F',
    errorColorHover: '#E06A70',
    errorColorPressed: '#B23A41',
    errorColorSuppl: '#FBECEC',
    // 墨色文字族（textColor3 与 --ad-ink-3 同源加深，满足 AA 正文 4.5:1）
    textColorBase: '#1F2329',
    textColor1: '#1F2329',
    textColor2: '#5C6270',
    textColor3: '#666B74',
    textColorDisabled: '#B4B8BF',
    // 发丝线与圆角
    borderColor: '#E8E5E0',
    dividerColor: '#E8E5E0',
    borderRadius: '10px',
    borderRadiusSmall: '6px',
    // 13/14 字号体系
    fontSize: '14px',
    fontSizeMini: '12px',
    fontSizeSmall: '13px',
    fontSizeMedium: '14px',
    fontSizeLarge: '15px',
    fontSizeHuge: '16px',
    fontWeightStrong: '600',
    // 面色：canvas 底 + surface 卡片
    baseColor: '#FFFFFF',
    bodyColor: '#F7F5F2',
    cardColor: '#FFFFFF',
    modalColor: '#FFFFFF',
    popoverColor: '#FFFFFF',
    tableColor: '#FFFFFF',
    inputColor: '#FFFFFF',
    actionColor: '#F4F2EE',
    hoverColor: '#F4F2EE',
    pressedColor: '#EDEAE5'
  },
  Button: {
    borderRadiusMedium: '8px',
    fontWeightStrong: '600'
  },
  Tag: {
    borderRadius: '6px'
  },
  Input: {
    borderColor: '#E8E5E0',
    borderHover: '#DDD9D2',
    borderFocus: '#4C6FFF',
    boxShadowFocus: '0 0 0 2px rgba(76, 111, 255, 0.15)',
    color: '#FFFFFF',
    colorFocus: '#FFFFFF',
    textColor: '#1F2329',
    placeholderColor: '#666B74',
    borderRadius: '8px'
  },
  Select: {
    // n-select 的边框由 InternalSelection 绘制（border 为整串 shorthand），peer 覆写才生效
    peers: {
      InternalSelection: {
        border: '1px solid #E8E5E0',
        borderHover: '1px solid #DDD9D2',
        borderActive: '1px solid #4C6FFF',
        borderFocus: '1px solid #4C6FFF',
        borderRadius: '8px'
      }
    }
  },
  Collapse: {
    // n-collapse 无外框，分隔发丝线走 dividerColor
    dividerColor: '#E8E5E0',
    titleTextColor: '#1F2329',
    arrowColor: '#666B74'
  },
  Card: {
    borderColor: '#E8E5E0',
    borderRadius: '10px',
    color: '#FFFFFF',
    titleTextColor: '#1F2329'
  }
}

/**
 * 顶栏主操作按钮皮肤：墨黑底白字。
 * naive-ui 将主题变量注入为元素 inline style，外部类选择器无法覆盖，
 * 故走 per-instance theme-overrides（键名受 Button 主题类型约束，写错即编译报错）。
 * 全局 primary 保留靛蓝，仅承担链接/开关等交互强调。
 */
export const adBtnInkOverrides: NonNullable<ButtonProps['themeOverrides']> = {
  color: '#1F2329',
  colorHover: '#34383F',
  colorPressed: '#14171B',
  colorFocus: '#34383F',
  colorDisabled: '#1F2329',
  textColor: '#FFFFFF',
  textColorHover: '#FFFFFF',
  textColorPressed: '#FFFFFF',
  textColorFocus: '#FFFFFF',
  textColorDisabled: '#FFFFFF',
  border: '1px solid #1F2329',
  borderHover: '1px solid #34383F',
  borderPressed: '1px solid #14171B',
  borderFocus: '1px solid #34383F',
  borderDisabled: '1px solid #1F2329',
  rippleColor: '#1F2329',
  borderRadiusSmall: '8px',
  fontSizeSmall: '12px'
}

/** 顶栏次操作按钮皮肤：白底 + 发丝强线描边 + 主墨字 */
export const adBtnOutlineOverrides: NonNullable<ButtonProps['themeOverrides']> = {
  color: '#FFFFFF',
  colorHover: '#F4F2EE',
  colorPressed: '#EDEAE5',
  colorFocus: '#FFFFFF',
  colorDisabled: '#FFFFFF',
  textColor: '#1F2329',
  textColorHover: '#1F2329',
  textColorPressed: '#1F2329',
  textColorFocus: '#1F2329',
  textColorDisabled: '#B4B8BF',
  border: '1px solid #DDD9D2',
  borderHover: '1px solid #DDD9D2',
  borderPressed: '1px solid #DDD9D2',
  borderFocus: '1px solid #DDD9D2',
  borderDisabled: '1px solid #E8E5E0',
  rippleColor: '#DDD9D2',
  borderRadiusSmall: '8px',
  fontSizeSmall: '12px'
}
