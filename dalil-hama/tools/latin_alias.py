# دليل حماة: محوّل أسماء لاتينية إلى أسماء عربية للبحث (نطق + ترجمة الكلمات الشائعة).
# يُستعمل لإضافة وسم عربي لنشاط باسم لاتيني فقط ليجده البحث بالعربية. الناتج آلي تقريبي: يُراجع ويُعدَّل من «الوسوم» في الإدارة.
# لا يحوي أرقاماً ولا بيانات خاصة، فهو آمن في المستودع العام.
import re, json

# كلمات شائعة: ترجمة + نطق معاً حين يفيد البحث بهما (الناتج نص عربي واحد لكل كلمة)
WORDS = {
 # عامة تجارية
 'hama': 'حماة', 'syria': 'سوريا', 'sy': 'سوريا', 'syrian': 'سوري', 'dr': 'دكتور', 'doctor': 'دكتور',
 'al': 'ال', 'el': 'ال', 'abu': 'أبو', 'abo': 'أبو', 'bin': 'بن', 'ibn': 'ابن', 'um': 'أم', 'umm': 'أم',
 'clinic': 'عيادة', 'clinics': 'عيادات', 'dental': 'دنتال أسنان', 'dentist': 'طبيب أسنان', 'dent': 'أسنان',
 'center': 'سنتر مركز', 'centre': 'سنتر مركز', 'store': 'ستور متجر', 'stores': 'متاجر', 'shop': 'شوب محل', 'shops': 'محلات',
 'salon': 'صالون', 'saloon': 'صالون', 'restaurant': 'مطعم', 'resto': 'مطعم', 'cafe': 'كافيه مقهى', 'caf': 'كافيه', 'coffee': 'كوفي قهوة',
 'shoes': 'شوز أحذية', 'shoe': 'حذاء', 'nails': 'نيلز أظافر', 'nail': 'أظافر', 'makeup': 'ميك اب مكياج', 'make': 'ميك', 'up': 'اب',
 'boutique': 'بوتيك', 'fashion': 'فاشن أزياء', 'beauty': 'بيوتي تجميل', 'photography': 'فوتوغرافي تصوير', 'photographer': 'مصور',
 'photo': 'فوتو صور', 'cars': 'كارز سيارات', 'car': 'كار سيارة', 'auto': 'اوتو سيارات', 'motors': 'موتورز', 'care': 'كير عناية',
 'company': 'شركة', 'co': 'شركة', 'corp': 'شركة', 'group': 'مجموعة', 'trading': 'تجارة', 'services': 'خدمات', 'service': 'خدمة',
 'golden': 'غولدن ذهبي', 'gold': 'غولد ذهب', 'silver': 'سيلفر فضة', 'art': 'ارت فن', 'arts': 'فنون', 'artist': 'فنان',
 'kids': 'كيدز أطفال', 'kid': 'طفل', 'baby': 'بيبي', 'sweet': 'سويت حلويات', 'sweets': 'سويتس حلويات', 'tech': 'تك تقنية',
 'technology': 'تكنولوجيا', 'style': 'ستايل', 'rose': 'روز وردة', 'lab': 'لاب مختبر', 'laboratory': 'مختبر', 'labs': 'مختبرات',
 'smile': 'سمايل ابتسامة', 'home': 'هوم منزل', 'food': 'فود طعام', 'foods': 'أطعمة', 'design': 'ديزاين تصميم', 'designer': 'مصمم',
 'studio': 'ستوديو', 'pharmacy': 'صيدلية', 'pharma': 'فارما', 'line': 'لاين', 'new': 'نيو جديد', 'sport': 'سبورت رياضة', 'sports': 'سبورت رياضة',
 'resin': 'ريزن', 'dream': 'دريم حلم', 'dreams': 'دريمز أحلام', 'one': 'ون واحد', 'mobile': 'موبايل', 'mobiles': 'موبايلات', 'tel': 'تل هاتف',
 'phone': 'فون هاتف', 'phones': 'فونز هواتف', 'library': 'مكتبة', 'city': 'سيتي مدينة', 'medical': 'ميديكال طبي', 'medic': 'طبي',
 'hair': 'هير شعر', 'hotel': 'فندق', 'land': 'لاند', 'market': 'ماركت سوق', 'communications': 'اتصالات', 'chocolate': 'شوكولا شوكولاتة',
 'office': 'مكتب أوفيس', 'cake': 'كيك', 'cakes': 'كيك', 'online': 'اونلاين', 'more': 'مور', 'top': 'توب', 'barber': 'حلاق باربر',
 'power': 'باور', 'trend': 'ترند', 'gifts': 'هدايا', 'gift': 'هدية', 'house': 'هاوس بيت', 'world': 'وورلد عالم', 'pc': 'كمبيوتر',
 'computer': 'كمبيوتر', 'computers': 'كمبيوتر', 'ice': 'آيس', 'cream': 'كريم', 'tools': 'أدوات', 'star': 'ستار نجمة', 'stars': 'ستارز نجوم',
 'derma': 'ديرما جلدية', 'dermatology': 'جلدية', 'family': 'فاميلي عائلة', 'handmade': 'هاند ميد يدوي', 'pizza': 'بيتزا', 'pure': 'بيور نقي',
 'net': 'نت', 'light': 'لايت', 'lights': 'لايتس إضاءة', 'queen': 'كوين ملكة', 'king': 'كينج ملك', 'royal': 'رويال ملكي', 'prince': 'برنس أمير',
 'princess': 'برنسس أميرة', 'luxury': 'لاكشري فخم', 'lux': 'لوكس', 'plus': 'بلس', 'pro': 'برو', 'best': 'بيست', 'good': 'جود', 'happy': 'هابي',
 'smart': 'سمارت ذكي', 'digital': 'ديجيتال رقمي', 'electronics': 'إلكترونيات', 'electric': 'كهرباء', 'solar': 'سولار طاقة شمسية',
 'energy': 'طاقة', 'gym': 'جيم', 'fitness': 'فتنس لياقة', 'pet': 'بت', 'pets': 'حيوانات أليفة', 'flowers': 'ورد زهور', 'flower': 'ورد',
 'jewelry': 'مجوهرات', 'jewellery': 'مجوهرات', 'gold': 'ذهب', 'watch': 'ساعة', 'watches': 'ساعات', 'optic': 'نظارات بصريات', 'optics': 'بصريات',
 'optical': 'بصريات', 'bakery': 'مخبز بيكري', 'burger': 'برغر', 'grill': 'غريل مشاوي', 'shawarma': 'شاورما', 'sandwich': 'ساندويش',
 'fried': 'مقلي', 'chicken': 'شيكن دجاج', 'fish': 'سمك', 'juice': 'جوس عصير', 'bar': 'بار', 'lounge': 'لاونج', 'bistro': 'بيسترو',
 'pub': 'بب', 'club': 'كلوب نادي', 'academy': 'أكاديمية', 'school': 'مدرسة', 'institute': 'معهد', 'university': 'جامعة', 'kindergarten': 'روضة',
 'nursery': 'حضانة', 'english': 'انجليزي', 'language': 'لغة', 'languages': 'لغات', 'training': 'تدريب', 'education': 'تعليم', 'learning': 'تعلم',
 'hospital': 'مشفى مستشفى', 'surgery': 'جراحة', 'surgical': 'جراحي', 'laser': 'ليزر', 'skin': 'سكن بشرة', 'spa': 'سبا', 'massage': 'مساج',
 'perfume': 'عطور بيرفيوم', 'perfumes': 'عطور', 'parfum': 'عطر', 'oud': 'عود', 'bags': 'حقائب', 'bag': 'حقيبة', 'clothes': 'ملابس',
 'kidswear': 'ملابس أطفال', 'wear': 'وير ملابس', 'men': 'رجالي', 'women': 'نسائي', 'ladies': 'سيدات', 'girls': 'بنات', 'boys': 'أولاد',
 'jeans': 'جينز', 'tailor': 'خياط', 'bridal': 'عرائس', 'wedding': 'زفاف أعراس', 'events': 'ايفنتس فعاليات', 'event': 'فعالية', 'party': 'بارتي حفلات',
 'planner': 'تنظيم', 'gaming': 'جيمنج ألعاب', 'games': 'ألعاب', 'game': 'لعبة', 'toys': 'ألعاب أطفال', 'tools': 'أدوات', 'hardware': 'خردوات',
 'paint': 'دهان', 'paints': 'دهانات', 'glass': 'زجاج', 'aluminum': 'ألمنيوم', 'steel': 'ستيل حديد', 'iron': 'حديد', 'wood': 'خشب', 'furniture': 'أثاث مفروشات',
 'carpet': 'سجاد', 'curtains': 'ستائر', 'decor': 'ديكور', 'decoration': 'ديكور', 'interior': 'داخلي', 'architecture': 'عمارة هندسة', 'engineering': 'هندسة',
 'construction': 'إنشاءات', 'building': 'بناء', 'real': 'عقارات ريل', 'estate': 'عقار', 'travel': 'سفر ترافل', 'tourism': 'سياحة', 'tours': 'جولات',
 'transport': 'نقل', 'shipping': 'شحن', 'cargo': 'كارغو شحن', 'delivery': 'توصيل ديليفري', 'express': 'اكسبرس', 'money': 'ماني أموال', 'exchange': 'صرافة',
 'bank': 'بنك', 'insurance': 'تأمين', 'law': 'قانون محاماة', 'lawyer': 'محامي', 'accounting': 'محاسبة', 'consulting': 'استشارات', 'agency': 'وكالة',
 'marketing': 'تسويق', 'media': 'ميديا إعلام', 'advertising': 'إعلان', 'print': 'طباعة', 'printing': 'طباعة', 'press': 'مطبعة', 'books': 'كتب', 'book': 'كتاب',
 'stationery': 'قرطاسية', 'office': 'مكتب', 'solutions': 'حلول', 'systems': 'أنظمة', 'software': 'برمجيات', 'web': 'ويب', 'apps': 'تطبيقات', 'it': 'آي تي',
 'network': 'شبكة', 'internet': 'انترنت', 'wifi': 'واي فاي', 'cctv': 'كاميرات مراقبة', 'security': 'أمن', 'safe': 'آمن', 'fire': 'حريق', 'water': 'مياه ووتر',
 'filter': 'فلتر', 'filters': 'فلاتر', 'air': 'هواء اير', 'clean': 'تنظيف كلين', 'cleaning': 'تنظيف', 'laundry': 'مغسلة', 'wash': 'غسيل', 'car wash': 'غسيل سيارات',
 'garage': 'كراج', 'tire': 'تاير إطارات', 'tires': 'إطارات', 'parts': 'قطع غيار', 'spare': 'قطع', 'oil': 'زيت', 'battery': 'بطارية', 'batteries': 'بطاريات',
 'led': 'ليد', 'solar': 'سولار', 'garden': 'غاردن حديقة', 'farm': 'مزرعة', 'organic': 'عضوي أورغانيك', 'natural': 'طبيعي ناتشورال', 'herbal': 'أعشاب', 'honey': 'عسل',
 'nuts': 'مكسرات', 'dates': 'تمور', 'spices': 'بهارات', 'tea': 'شاي', 'dairy': 'ألبان', 'milk': 'حليب', 'bread': 'خبز', 'pastry': 'معجنات', 'bakeries': 'أفران',
 'ice': 'آيس', 'icecream': 'آيس كريم بوظة', 'dessert': 'ديزرت حلويات', 'desserts': 'حلويات', 'candy': 'كاندي سكاكر', 'waffle': 'وافل', 'crepe': 'كريب',
 'donut': 'دونات', 'donuts': 'دونات', 'cookies': 'كوكيز', 'cupcake': 'كب كيك', 'mini': 'ميني', 'maxi': 'ماكسي', 'mega': 'ميغا', 'super': 'سوبر', 'ultra': 'ألترا',
 'by': '', 'for': '', 'of': '', 'the': '', 'and': 'و', 'a': '', 'in': '', 'at': '', 'on': '', 'to': '', 'with': 'مع', 'de': '',
}
# أسماء عربية مكتوبة بحروف لاتينية (شائعة)
NAMES = {
 'ahmad': 'أحمد', 'ahmed': 'أحمد', 'mohamad': 'محمد', 'mohammad': 'محمد', 'mohammed': 'محمد', 'mohamed': 'محمد', 'muhammad': 'محمد', 'mhmd': 'محمد', 'm': 'م',
 'omar': 'عمر', 'ali': 'علي', 'hasan': 'حسن', 'hassan': 'حسن', 'hussein': 'حسين', 'hussain': 'حسين', 'hosein': 'حسين', 'nour': 'نور', 'nur': 'نور', 'noor': 'نور',
 'masa': 'ماسة', 'aya': 'آية', 'sawa': 'سوا', 'sama': 'سما', 'feras': 'فراس', 'firas': 'فراس', 'khaled': 'خالد', 'khalid': 'خالد', 'yasser': 'ياسر', 'yaser': 'ياسر',
 'ibrahim': 'ابراهيم', 'abdullah': 'عبدالله', 'abdulla': 'عبدالله', 'abdulrahman': 'عبدالرحمن', 'abdelrahman': 'عبدالرحمن', 'abdulkader': 'عبدالقادر', 'abdulaziz': 'عبدالعزيز',
 'samer': 'سامر', 'sameer': 'سمير', 'samir': 'سمير', 'sami': 'سامي', 'majd': 'مجد', 'majed': 'ماجد', 'majid': 'ماجد', 'bassel': 'باسل', 'basel': 'باسل', 'bashar': 'بشار',
 'fadi': 'فادي', 'fares': 'فارس', 'fayez': 'فايز', 'fouad': 'فؤاد', 'ghassan': 'غسان', 'hady': 'هادي', 'hadi': 'هادي', 'hala': 'هلا', 'hani': 'هاني', 'hamza': 'حمزة',
 'hiba': 'هبة', 'heba': 'هبة', 'ibtisam': 'ابتسام', 'iyad': 'إياد', 'jamal': 'جمال', 'jihad': 'جهاد', 'karam': 'كرم', 'karim': 'كريم', 'kareem': 'كريم', 'lama': 'لمى',
 'lina': 'لينا', 'layla': 'ليلى', 'leen': 'لين', 'lana': 'لانا', 'mahmoud': 'محمود', 'maher': 'ماهر', 'maya': 'مايا', 'mazen': 'مازن', 'mena': 'منى', 'mona': 'منى',
 'moustafa': 'مصطفى', 'mustafa': 'مصطفى', 'nada': 'ندى', 'nadia': 'ناديا', 'nasser': 'ناصر', 'nazir': 'نذير', 'nizar': 'نزار', 'rami': 'رامي', 'raneem': 'رنيم',
 'rasha': 'رشا', 'rawan': 'روان', 'rayan': 'ريان', 'reem': 'ريم', 'rima': 'ريما', 'sara': 'سارة', 'sarah': 'سارة', 'salah': 'صلاح', 'salem': 'سالم', 'saleh': 'صالح',
 'sultan': 'سلطان', 'suhaib': 'صهيب', 'tamer': 'تامر', 'tarek': 'طارق', 'tariq': 'طارق', 'wael': 'وائل', 'walid': 'وليد', 'yara': 'يارا', 'yazan': 'يزن', 'youssef': 'يوسف',
 'yousef': 'يوسف', 'yusuf': 'يوسف', 'zaher': 'ظاهر', 'zeina': 'زينة', 'zain': 'زين', 'zaid': 'زيد', 'ziad': 'زياد', 'rahaf': 'رهف', 'rahma': 'رحمة', 'roua': 'روعة',
 'shahd': 'شهد', 'shams': 'شمس', 'shaza': 'شذى', 'sham': 'شام', 'shahba': 'شهباء', 'amer': 'عامر', 'amir': 'أمير', 'amira': 'أميرة', 'anas': 'أنس', 'anwar': 'أنور',
 'asma': 'أسماء', 'ayham': 'أيهم', 'ayman': 'أيمن', 'ayat': 'آيات', 'bayan': 'بيان', 'batoul': 'بتول', 'dana': 'دانا', 'dima': 'ديمة', 'diana': 'ديانا', 'duaa': 'دعاء',
 'eman': 'إيمان', 'elias': 'إلياس', 'eyad': 'إياد', 'farah': 'فرح', 'fatima': 'فاطمة', 'ghada': 'غادة', 'ghina': 'غنى', 'hind': 'هند', 'huda': 'هدى', 'jana': 'جنى',
 'joud': 'جود', 'jouri': 'جوري', 'judy': 'جودي', 'kinda': 'كندة', 'lamis': 'لميس', 'lujain': 'لجين', 'malak': 'ملك', 'mariam': 'مريم', 'maram': 'مرام', 'marwa': 'مروة',
 'nawal': 'نوال', 'noura': 'نورة', 'rahil': 'راحيل', 'raghad': 'رغد', 'rouba': 'روبا', 'ruba': 'ربى', 'sally': 'سالي', 'sandy': 'ساندي', 'salma': 'سلمى', 'sondos': 'سندس',
 'tala': 'تالا', 'tuqa': 'تقى', 'wafa': 'وفاء', 'yasmin': 'ياسمين', 'yasmeen': 'ياسمين', 'zahra': 'زهراء', 'zeinab': 'زينب', 'zoya': 'زويا',
 'safa': 'صفا', 'abdel': 'عبد', 'abd': 'عبد', 'abdul': 'عبد', 'allah': 'الله', 'rahman': 'الرحمن', 'shami': 'الشامي', 'homsi': 'الحمصي', 'halabi': 'الحلبي', 'hamwi': 'الحموي', 'hamawi': 'الحموي',
 'orontes': 'العاصي', 'assi': 'العاصي', 'asi': 'العاصي', 'naoura': 'ناعورة', 'noria': 'ناعورة', 'norias': 'نواعير', 'salamiyah': 'سلمية', 'masyaf': 'مصياف',
 'damascus': 'دمشق', 'aleppo': 'حلب', 'homs': 'حمص', 'latakia': 'اللاذقية', 'tartus': 'طرطوس', 'idlib': 'إدلب', 'syrias': 'سوريا', 'arab': 'عرب', 'arabic': 'عربي',
 'sham': 'شام', 'ashraf': 'أشرف', 'hamdan': 'حمدان', 'hamdi': 'حمدي', 'hamid': 'حميد', 'hammoud': 'حمود', 'hanan': 'حنان', 'haitham': 'هيثم', 'hazem': 'حازم', 'hisham': 'هشام',
}


WORDS.update({
 'shein': 'شي ان', 'architect': 'مهندس معماري ارشيتكت', 'architectural': 'معماري', 'choco': 'شوكو', 'dresses': 'فساتين دريسز', 'look': 'لوك',
 'max': 'ماكس', 'tulip': 'توليب', 'you': 'يو', 'your': 'يور', 'accessories': 'اكسسوارات', 'accessorise': 'اكسسوارات', 'arch': 'ارك', 'black': 'بلاك اسود',
 'chef': 'شيف', 'coco': 'كوكو', 'collection': 'كولكشن', 'designs': 'تصاميم', 'dietitian': 'اخصائي تغذية', 'dubai': 'دبي', 'elysees': 'اليزيه',
 'gallery': 'غاليري معرض', 'girl': 'جيرل بنت', 'infinity': 'انفينيتي', 'iphone': 'ايفون آيفون', 'lashes': 'رموش لاشز', 'lens': 'عدسات لنس',
 'life': 'لايف حياة', 'lighting': 'اضاءة', 'man': 'مان رجل', 'miss': 'ميس', 'mobily': 'موبايلي', 'nova': 'نوفا', 'open': 'اوبن', 'red': 'ريد احمر',
 'shopping': 'شوبينج تسوق', 'soft': 'سوفت', 'tasty': 'تيستي لذيذ', 'tattoo': 'تاتو وشم', 'technical': 'تقني', 'techno': 'تكنو', 'trendy': 'ترندي',
 'vision': 'فيجن رؤية', 'white': 'وايت ابيض', 'cafee': 'كافيه مقهى', 'caffe': 'كافيه مقهى', 'coffe': 'كوفي قهوة', 'cosmetics': 'كوزمتيك مستحضرات تجميل',
 'cosmetic': 'كوزمتيك مستحضرات تجميل', 'cosmatics': 'كوزمتيك مستحضرات تجميل', 'ceramic': 'سيراميك', 'boutiqe': 'بوتيك', 'clinc': 'عيادة', 'beautty': 'بيوتي تجميل',
 'beuty': 'بيوتي تجميل', 'barbershop': 'باربر شوب حلاق', 'balloons': 'بالونات', 'cheese': 'تشيز جبنة', 'cocktail': 'كوكتيل', 'color': 'كولر لون', 'colors': 'كولرز الوان',
 'commerce': 'تجارة', 'concept': 'كونسبت', 'couture': 'كوتور', 'crown': 'كراون تاج', 'billiards': 'بلياردو', 'bicycle': 'دراجات', 'caravan': 'كرفان', 'card': 'كارد بطاقة',
 'carwasher': 'غسيل سيارات', 'clothing': 'ملابس', 'business': 'بزنس اعمال', 'brand': 'براند', 'box': 'بوكس', 'advanced': 'متقدم', 'adwat': 'ادوات', 'afkar': 'افكار',
 'alhazwani': 'الهزواني', 'aljazeera': 'الجزيرة', 'aljajeh': 'الجاجة', 'alsham': 'الشام', 'alshamia': 'الشامية', 'alshamy': 'الشامي', 'alnoor': 'النور', 'alnajah': 'النجاح',
 'alkhalaf': 'الخلف', 'alkhaled': 'الخالد', 'alkhateeb': 'الخطيب', 'alkhayat': 'الخياط', 'alsayed': 'السيد', 'alsoud': 'السود', 'alomar': 'العمر', 'alyousef': 'اليوسف',
 'almasri': 'المصري', 'almadani': 'المدني', 'alsabbagh': 'الصباغ', 'alsarraj': 'السراج', 'alnasr': 'النصر', 'alamal': 'الامل', 'alassad': 'الاسد', 'alatlal': 'الاطلال',
 'atlaal': 'الاطلال', 'alabdallah': 'العبدالله', 'alahdab': 'الاهداب', 'ahdab': 'احداب', 'alrajab': 'الرجب', 'alrabee': 'الربيع', 'alwani': 'علواني', 'afandi': 'افندي',
 'abood': 'عبود', 'abod': 'عبود', 'aboud': 'عبود', 'adel': 'عادل', 'adnan': 'عدنان', 'aref': 'عارف', 'nofal': 'نوفل', 'othman': 'عثمان', 'salloum': 'سلوم', 'nawras': 'نورس',
 'anna': 'آنا', 'eva': 'ايفا', 'haya': 'حياة', 'yom': 'يوم', 'shaam': 'شام', 'ya': 'يا', 'shado': 'شادو', 'remy': 'ريمي', 'riva': 'ريفا', 'baker': 'بيكر', 'kebab': 'كباب',
 'ammar': 'عمار', 'amjad': 'امجاد', 'amer': 'عامر', 'aziz': 'عزيز', 'badr': 'بدر', 'bashe': 'باشا', 'basha': 'باشا', 'basma': 'بسمة', 'boshra': 'بشرى', 'bakour': 'باكور',
 'aya': 'آية', 'abeer': 'عبير', 'abed': 'عابد', 'abeed': 'عبيد', 'adi': 'عدي', 'aman': 'امان', 'amran': 'عمران', 'angel': 'انجل ملاك', 'aqua': 'اكوا', 'arty': 'ارتي',
 'asia': 'اسيا', 'awad': 'عوض', 'ayla': 'ايلا', 'aylol': 'ايلول', 'ayloul': 'ايلول', 'be': 'بي', 'bear': 'بير', 'bird': 'بيرد طير', 'blue': 'بلو ازرق', 'bloom': 'بلوم',
 'body': 'بودي جسم', 'bon': 'بون', 'bonbon': 'بونبون', 'butterfly': 'بترفلاي فراشة', 'canon': 'كانون', 'cell': 'سيل خلوي', 'chic': 'شيك', 'class': 'كلاس',
})

WORDS.update({'take': 'تيك', 'away': 'اواي', 'euro': 'يورو', 'tec': 'تك', 'kamal': 'كمال', 'sawass': 'السواس', 'zawaya': 'زوايا', 'zher': 'زهر', 'aylol': 'ايلول',
 'supermarket': 'سوبرماركت', 'handmade': 'هاند ميد يدوي', 'winter': 'وينتر شتاء', 'summer': 'سمر صيف', 'warm': 'دافئ', 'speed': 'سبيد سرعة', 'meow': 'مياو',
 'jewels': 'جواهر', 'bakery': 'مخبز بيكري', 'real': 'ريل', 'estate': 'عقارات', 'tele': 'تيلي', 'com': 'كوم', 'catch': 'كاتش',
 'montissory': 'مونتيسوري', 'montessori': 'مونتيسوري', 'venous': 'فينوس', 'ramez': 'رامز', 'bodor': 'بودور'})

CONS = {'b':'ب','c':'ك','d':'د','f':'ف','g':'غ','h':'ه','j':'ج','k':'ك','l':'ل','m':'م','n':'ن','p':'ب','q':'ق','r':'ر','s':'س','t':'ت','v':'ف','w':'و','x':'كس','z':'ز'}
LETTERS = {'a':'إي','b':'بي','c':'سي','d':'دي','e':'إي','f':'إف','g':'جي','h':'إتش','i':'آي','j':'جي','k':'كي','l':'إل','m':'إم','n':'إن','o':'أو','p':'بي','q':'كيو','r':'آر','s':'إس','t':'تي','u':'يو','v':'في','w':'دبليو','x':'إكس','y':'واي','z':'زد'}
DIGRAPHS = [('sch','ش'),('tch','تش'),('sh','ش'),('ch','تش'),('th','ث'),('kh','خ'),('gh','غ'),('ph','ف'),('ck','ك'),('dh','ذ'),('zh','ج'),('ng','نغ'),('qu','كو')]
VOW = set('aeiouy')

def translit_word(w):
    w = w.lower()
    if w in NAMES: return NAMES[w]
    # «Al» ملتصقة بالاسم (Alshami, Alammori): ال + الباقي
    if len(w) >= 7 and w.startswith('ala') and w[3] not in 'aeiouxn':
        return 'ال' + translit_word(w[2:])
    if len(w) >= 6 and (w.startswith('al') or w.startswith('el')) and w[2] not in 'aeiou' + 'l':
        rest = w[2:]
        ar = NAMES.get(rest) or translit_word(rest)
        return ar if ar.startswith('ال') else 'ال' + ar
    out = []; i = 0; n = len(w)
    # e صامتة في آخر الكلمة بعد حرف ساكن
    if n > 3 and w.endswith('e') and w[-2] not in VOW: w2 = w[:-1]
    else: w2 = w
    n = len(w2)
    while i < n:
        ch = w2[i]; nxt = w2[i+1] if i+1 < n else ''
        for dg, ar in DIGRAPHS:
            if w2.startswith(dg, i):
                out.append(ar); i += len(dg); break
        else:
            if ch in VOW:
                two = w2[i:i+2]
                if two == 'aa': out.append('أ' if i == 0 else 'ا'); i += 2; continue
                if two == 'uu': out.append('و'); i += 2; continue
                if two == 'ii': out.append('ي'); i += 2; continue
                # e قبل آخر حرف ساكن في آخر الكلمة (kamel, nader, master): تُحذف
                if ch == 'e' and i > 0 and i == n - 2 and nxt not in VOW and n > 3: i += 1; continue
                if two in ('ee','ea'): out.append('ي'); i += 2; continue
                if two in ('oo','ou'): out.append('و'); i += 2; continue
                if two in ('ai','ay','ei','ey'): out.append('اي'); i += 2; continue
                if two in ('au','aw','ow'): out.append('او'); i += 2; continue
                if two == 'ie': out.append('ي'); i += 2; continue
                first = (i == 0)
                if ch == 'a': out.append('أ' if first else 'ا')
                elif ch == 'e': out.append('إ' if first else ('ي' if (nxt and nxt not in VOW and i+2 < n+1) else ''))
                elif ch == 'i': out.append('إ' if first else 'ي')
                elif ch == 'o': out.append('أو' if first else 'و')
                elif ch == 'u': out.append('أو' if first else 'و')
                elif ch == 'y': out.append('ي')
                i += 1
            elif ch == 'c':
                out.append('س' if nxt in ('e','i','y') else 'ك'); i += 1
            elif ch == 'g':
                out.append('ج' if nxt in ('e','i','y') else 'غ'); i += 1
            elif ch == 's' and 0 < i < n-1 and w2[i-1] in VOW and nxt in VOW:
                out.append('ز'); i += 1
            elif ch in CONS:
                if out and i > 0 and w2[i-1] == ch: i += 1; continue
                out.append(CONS[ch]); i += 1
            else:
                i += 1
    return ''.join(out)

def alias(name):
    s = re.sub(r"[_/\\|•·–—-]+", ' ', name)
    toks = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?|\d+", s)
    parts = []
    for t in toks:
        if t.isdigit(): parts.append(t); continue
        t = t.replace("'", '')
        lw = t.lower()
        if lw in WORDS: ar = WORDS[lw]
        elif lw in NAMES: ar = NAMES[lw]
        elif t.isupper() and len(t) <= 4: ar = ' '.join(LETTERS[c.lower()] for c in t)
        elif len(t) == 1: ar = LETTERS[lw]
        else: ar = translit_word(t)
        if ar: parts.append(ar)
    res = ' '.join(parts)
    # «ال» الملتصقة: «ال» + كلمة ← «الكلمة»
    res = re.sub(r'(?:^| )ال (\S)', lambda m: (' ' if m.group(0).startswith(' ') else '') + 'ال' + m.group(1), res)
    res = re.sub(r'(^| )الال', r'\1ال', res)
    return re.sub(r'\s+', ' ', res).strip()

if __name__ == '__main__':
    # الاستعمال: python3 dalil-hama/tools/latin_alias.py "Dental Clinic" "Sama Cafe" ...
    import sys
    for t in sys.argv[1:]:
        print(t, '->', alias(t))
