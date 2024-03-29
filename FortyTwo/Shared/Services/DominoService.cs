﻿using FortyTwo.Shared.Extensions;
using FortyTwo.Shared.Models;
using System.Collections.Generic;

namespace FortyTwo.Shared.Services
{
    public enum DominoType
    {
        DoubleSix = 6
    }

    public class DominoService : IDominoService
    {
        public List<Domino> InitDominos(DominoType type, bool shuffle = true)
        {
            var dominos = new List<Domino>();
            for (var i = 0; i <= (int) type; ++i)
            {
                for (var j = i; j <= (int) type; ++j)
                {
                    dominos.Add(new Domino(i, j));
                }
            }

            if (shuffle)
            {
                dominos.Shuffle(ThreadSafeRandom.Instance.Next(11) + 1);
            }

            return dominos;
        }
    }
}
