import type { ButtonProps, GlobalThemeOverrides } from 'naive-ui'

/**
 * D1 米白极简设计系统的 Naive UI 主题覆写唯一入口。
 * 语义色族（hover/pressed/supplied）与 style.css 的 :root 令牌同源，
 * 组件层不允许再单独改色，保证 naive 控件与手写样式同一套色板。
 */
export const themeOverrides: GlobalThemeOverrides = {
  common: {
    // 交互强调色：靛蓝族
    primaryColor: '#4C6FFF',
    primaryColorHover: '#6D87FF',
    primaryColorPressed: '#3B5BE6',
    primaryColorSuppl: '#EEF2FF',
    infoColor: '#4C6FFF',
    infoColorHover: '#6D87FF',
    infoColorPressed: '#3B5BE6',
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
    // 墨色文字族
    textColorBase: '#1F2329',
    textColor1: '#1F2329',
    textColor2: '#5C6270',
    textColor3: '#8A8F98',
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
    placeholderColor: '#8A8F98',
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
    arrowColor: '#8A8F98'
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
