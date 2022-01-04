using System;
using System.Linq;
using System.Text.Json.Serialization;

namespace FortyTwo.Shared.Models
{
    public class Trick
    {
        [JsonConstructor]
        public Trick() { }

        public string PlayerId { get; set; }
        public Teams? Team { get; set; }
        public Suit? Suit { get; set; }
        public Domino[] Dominos { get; set; } = new Domino[4];
        public int Value => Dominos?.Sum(x => x?.Value) + 1 ?? 0;

        public bool IsFull()
            => Array.IndexOf(Dominos, null) == -1;

        public void AddDomino(Domino domino, Suit trump)
        {
            var index = Array.IndexOf(Dominos, null);

            // TODO: think of a cleaner approach here
            if (index == -1) throw new Exception("Trick is already full");

            if (index == 0)
            {
                Suit ??= domino.GetSuit(trump);
            }

            Dominos[index] = domino;
        }
    }
}
