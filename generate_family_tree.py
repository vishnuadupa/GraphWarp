import csv
import random

# Seed for reproducibility
random.seed(42)

# Source data for generation
FIRST_NAMES_MALE = [
    "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles", "Christopher",
    "Daniel", "Matthew", "Anthony", "Mark", "Donald", "Steven", "Paul", "Andrew", "Joshua", "Kenneth",
    "Kevin", "Brian", "George", "Edward", "Ronald", "Timothy", "Jason", "Jeffrey", "Ryan", "Jacob",
    "Gary", "Nicholas", "Eric", "Jonathan", "Stephen", "Larry", "Justin", "Scott", "Brandon", "Benjamin",
    "Samuel", "Gregory", "Alexander", "Frank", "Patrick", "Raymond", "Jack", "Dennis", "Jerry", "Tyler"
]

FIRST_NAMES_FEMALE = [
    "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan", "Jessica", "Sarah", "Karen",
    "Nancy", "Lisa", "Betty", "Margaret", "Sandra", "Ashley", "Dorothy", "Kimberly", "Emily", "Donna",
    "Michelle", "Carol", "Amanda", "Melissa", "Deborah", "Stephanie", "Rebecca", "Sharon", "Laura", "Cynthia",
    "Kathleen", "Amy", "Shirley", "Angela", "Helen", "Anna", "Brenda", "Pamela", "Nicole", "Samantha",
    "Katherine", "Emma", "Ruth", "Christine", "Catherine", "Debra", "Rachel", "Carolyn", "Janet", "Virginia"
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
    "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
    "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
    "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
    "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts"
]

LOCATIONS = [
    ("London", "United Kingdom"),
    ("Paris", "France"),
    ("Berlin", "Germany"),
    ("Rome", "Italy"),
    ("Madrid", "Spain"),
    ("Tokyo", "Japan"),
    ("New York", "United States"),
    ("Toronto", "Canada"),
    ("Sydney", "Australia"),
    ("Dublin", "Ireland"),
    ("Edinburgh", "United Kingdom"),
    ("Geneva", "Switzerland"),
    ("Vienna", "Austria"),
    ("Amsterdam", "Netherlands"),
    ("Brussels", "Belgium"),
    ("Copenhagen", "Denmark"),
    ("Stockholm", "Sweden"),
    ("Oslo", "Norway"),
    ("Helsinki", "Finland"),
    ("Reykjavik", "Iceland")
]

class Person:
    def __init__(self, id, name, gender, generation, city, country):
        self.id = id
        self.name = name
        self.gender = gender
        self.generation = generation
        self.city = city
        self.country = country
        self.spouse = None
        self.parents = []
        self.children = []

def generate_tree(target_count=500):
    people = []
    current_id = 1
    
    # 1. Generation 0: Founders
    founders_count = 24
    for i in range(founders_count):
        gender = "M" if i % 2 == 0 else "F"
        first = random.choice(FIRST_NAMES_MALE if gender == "M" else FIRST_NAMES_FEMALE)
        last = random.choice(LAST_NAMES)
        name = f"{first} {last}"
        city, country = random.choice(LOCATIONS)
        people.append(Person(current_id, name, gender, 0, city, country))
        current_id += 1
        
    # Pair founders as couples
    couples = []
    males_g0 = [p for p in people if p.generation == 0 and p.gender == "M"]
    females_g0 = [p for p in people if p.generation == 0 and p.gender == "F"]
    for m, f in zip(males_g0, females_g0):
        # Align last names for marriage
        f.name = f.name.split()[0] + " " + m.name.split()[1]
        m.spouse = f
        f.spouse = m
        couples.append((m, f))

    # 2. Subsequent generations
    gen = 1
    while len(people) < target_count:
        next_gen_people = []
        # Each couple from the previous generation has children (2 to 4 children)
        for father, mother in couples:
            if len(people) + len(next_gen_people) >= target_count:
                break
                
            num_children = random.randint(2, 4)
            for _ in range(num_children):
                if len(people) + len(next_gen_people) >= target_count:
                    break
                gender = random.choice(["M", "F"])
                first = random.choice(FIRST_NAMES_MALE if gender == "M" else FIRST_NAMES_FEMALE)
                last = father.name.split()[1] # Inherits father's last name
                name = f"{first} {last}"
                
                # Inherit location with some chance of migration
                if random.random() < 0.20:
                    city, country = random.choice(LOCATIONS)
                else:
                    city, country = father.city, father.country
                    
                child = Person(current_id, name, gender, gen, city, country)
                child.parents = [father, mother]
                father.children.append(child)
                mother.children.append(child)
                next_gen_people.append(child)
                current_id += 1
                
        people.extend(next_gen_people)
        
        # Form couples within the newly generated generation for the next loop
        # Marry people who are not siblings (different parents)
        males_next = [p for p in next_gen_people if p.gender == "M"]
        females_next = [p for p in next_gen_people if p.gender == "F"]
        
        random.shuffle(males_next)
        random.shuffle(females_next)
        
        couples = []
        for m in males_next:
            for f in females_next:
                if f.spouse is None and m.spouse is None:
                    # Sibling check
                    m_parents = set(m.parents)
                    f_parents = set(f.parents)
                    if not m_parents.intersection(f_parents):
                        # Marriage!
                        f.name = f.name.split()[0] + " " + m.name.split()[1] # Change last name
                        # Move to a mutual city
                        if random.random() < 0.5:
                            f.city, f.country = m.city, m.country
                        else:
                            m.city, m.country = f.city, f.country
                        m.spouse = f
                        f.spouse = m
                        couples.append((m, f))
                        break
                        
        gen += 1
        
    return people

def write_csv(people, filename="test_family_tree_500.csv"):
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        # Header
        writer.writerow(["Person A", "Relationship", "Person B", "City", "Country"])
        
        relationships_set = set()
        
        for p in people:
            # 1. Location relationship
            writer.writerow([p.name, "LIVES_IN", f"{p.city}, {p.country}", p.city, p.country])
            
            # 2. Spouse relationship
            if p.spouse:
                pair = tuple(sorted([p.name, p.spouse.name]))
                if ("SPOUSE", pair) not in relationships_set:
                    writer.writerow([p.name, "MARRIED_TO", p.spouse.name, p.city, p.country])
                    relationships_set.add(("SPOUSE", pair))
                    
            # 3. Parent-Child relationship
            for parent in p.parents:
                writer.writerow([parent.name, "PARENT_OF", p.name, p.city, p.country])
                
            # 4. Sibling relationship (derived from common parents)
            if len(p.parents) > 0:
                father = p.parents[0]
                siblings = [sib for sib in father.children if sib.id != p.id]
                for sib in siblings:
                    pair = tuple(sorted([p.name, sib.name]))
                    if ("SIBLING", pair) not in relationships_set:
                        writer.writerow([p.name, "SIBLING_OF", sib.name, p.city, p.country])
                        relationships_set.add(("SIBLING", pair))

if __name__ == "__main__":
    print("Generating family tree of 500 people...")
    tree = generate_tree(500)
    print(f"Successfully generated {len(tree)} people.")
    write_csv(tree, "test_family_tree_500.csv")
    print("Successfully wrote test_family_tree_500.csv!")
