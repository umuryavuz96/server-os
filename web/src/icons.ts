// One icon set for the whole panel: Lucide (24 px grid, stroke 1.8, the weight of the old hand-drawn nav icons).
// Add an icon here and use it by name through <Icon name="…">; only the icons listed end up in the bundle.
import { MessagesSquare, Waypoints, Activity, ArrowUpRight, Download, MemoryStick, Grip, Maximize2, Minimize2, Archive, ArrowDown, AudioLines, Copy, History, Keyboard, Mic, MicOff, QrCode, RotateCcw, Speaker, Check, Lock, Laptop, Beer, Bell, Blocks, Boxes, Bot, Car, ChevronDown, CircleCheck, Clapperboard, Clock, Cloud, Code, Cog, Compass, Coins, Cpu, Database, ExternalLink, Eye, EyeOff, Flag, Gauge, FileText, Folder, Globe, HardDrive, KeyRound, LayoutDashboard, LayoutGrid, LoaderCircle, Menu, Monitor, Network, Package, Pencil, Play, Plug, RefreshCw, Rss, Scissors, ScrollText, Send, ShieldCheck, ShoppingCart, SlidersHorizontal, Smartphone, Sparkles, Square, SquareTerminal, Terminal, Timer, Trash2, TrendingUp, TriangleAlert, Volume2, Wallet, Webhook, Wrench, X, Zap, Sun, CloudSun, CloudRain, CloudDrizzle, CloudLightning, CloudSnow, CloudFog, Wind, Moon, Lightbulb, Power, Thermometer, Blinds, Fan, Tv, Music, Pause, CalendarDays, MapPin, TrendingDown, Minus, Image, Droplets, DoorOpen, Plus, Camera, Search, House, Layers, FlipHorizontal2, Move, Cctv } from "lucide-vue-next";

export const ICONS = {
  waypoints: Waypoints, message: MessagesSquare,
  activity: Activity, "arrow-up-right": ArrowUpRight, download: Download, "memory-stick": MemoryStick,
  grip: Grip, maximize: Maximize2, minimize: Minimize2, archive: Archive, "arrow-down": ArrowDown, copy: Copy, history: History, keyboard: Keyboard, mic: Mic, "mic-off": MicOff, "qr-code": QrCode, "rotate-ccw": RotateCcw, speaker: Speaker, check: Check, lock: Lock, laptop: Laptop, "audio-lines": AudioLines, beer: Beer, bell: Bell, blocks: Blocks, boxes: Boxes, bot: Bot, car: Car, "chevron-down": ChevronDown, "circle-check": CircleCheck,
  clapperboard: Clapperboard, clock: Clock, cloud: Cloud, code: Code, cog: Cog, compass: Compass, database: Database, "file-text": FileText, folder: Folder, globe: Globe,
  "hard-drive": HardDrive, "key-round": KeyRound, "layout-dashboard": LayoutDashboard, "layout-grid": LayoutGrid, loader: LoaderCircle, menu: Menu,
  monitor: Monitor, network: Network, package: Package, pencil: Pencil, play: Play, plug: Plug, rss: Rss, scissors: Scissors, "scroll-text": ScrollText, send: Send,
  "shield-check": ShieldCheck, "shopping-cart": ShoppingCart, sliders: SlidersHorizontal, smartphone: Smartphone, sparkles: Sparkles, square: Square,
  "square-terminal": SquareTerminal, terminal: Terminal, timer: Timer, trash: Trash2, "trending-up": TrendingUp, "triangle-alert": TriangleAlert,
  volume: Volume2, wallet: Wallet, coins: Coins, cpu: Cpu, "external-link": ExternalLink, eye: Eye, "eye-off": EyeOff, flag: Flag, gauge: Gauge, "refresh-cw": RefreshCw, webhook: Webhook, wrench: Wrench, x: X, zap: Zap,
  sun: Sun, "cloud-sun": CloudSun, "cloud-rain": CloudRain, "cloud-drizzle": CloudDrizzle, "cloud-lightning": CloudLightning, "cloud-snow": CloudSnow, "cloud-fog": CloudFog, wind: Wind, moon: Moon,
  lightbulb: Lightbulb, power: Power, thermometer: Thermometer, blinds: Blinds, fan: Fan, tv: Tv, music: Music, pause: Pause, calendar: CalendarDays, "map-pin": MapPin, "trending-down": TrendingDown, minus: Minus, image: Image, droplets: Droplets, door: DoorOpen, plus: Plus, camera: Camera, search: Search, house: House, layers: Layers, flip: FlipHorizontal2, move: Move, cctv: Cctv,
} as const;
export type IconName = keyof typeof ICONS;
