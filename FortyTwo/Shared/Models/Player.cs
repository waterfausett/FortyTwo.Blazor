using System;
using System.Collections.Generic;

namespace FortyTwo.Shared.Models
{
    public class Player
    {
        public Guid Id { get; set; }
        public string Name { get; set; }
        public List<Domino> Dominos { get; set; } = new List<Domino>();
    }
}
