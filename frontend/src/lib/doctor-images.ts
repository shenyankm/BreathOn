import blood from '@/assets/ip/doctor-blood.jpg'
import breast from '@/assets/ip/doctor-breast.jpg'
import cardio from '@/assets/ip/doctor-cardio.jpg'
import endocrine from '@/assets/ip/doctor-endocrine.jpg'
import general from '@/assets/ip/doctor-general.jpg'
import oncology from '@/assets/ip/doctor-oncology.jpg'
import pediatrics from '@/assets/ip/doctor-pediatrics.jpg'
import fallback from '@/assets/practice/doctor-illustration.png'

const images: Record<string, string> = { blood, breast, cardio, endocrine, general, oncology, pediatrics }
export function ipImage(key?: string) { return (key && images[key]) || fallback }
